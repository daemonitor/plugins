import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readdir } from "node:fs/promises"
import * as path from "node:path"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

// WordPress security-posture plugin. Runs on the WP host (where the daemonitor
// client already runs) and polls the state that the Archpaper intrusions moved
// through: admin accounts, page statuses, must-use plugins, and the web user's
// crontab. It emits raw observations only — severity and the new-admin /
// admin-demotion DIFFS are decided server-side in the ingest handler
// (clientstate/update.put.ts, case "wordpress"), so an agent restart can't reset
// the baseline and let a change slip through.
//
// Collection is via WP-CLI + filesystem + crontab (no DB credentials, no extra
// npm dependency) — mirroring MongoDBPlugin's shell-out pattern. Every collector
// is best-effort and isolated: one failing (e.g. crontab needs root) degrades
// that one field to null, it never kills the poll.

const pexec = promisify(execFile)

interface WpSite {
  name?: string // display label; defaults to the host dir name
  path: string // absolute WordPress root (where wp-config.php lives)
  url?: string // public URL, for reference/deep-linking only
  wpCli?: string // wp binary (default "wp")
  runAs?: string // OS user to run wp-cli as (via sudo -u); WP-CLI refuses root
  cronUser?: string // crontab -u target (default "www-data")
  muPluginsAllowlist?: string[] // known-good mu-plugin filenames
  criticalPages?: string[] // slugs whose trashing = alert (login, home, ...)
  servicePatterns?: string[] // login/email substrings flagging service-acct admins
}

interface WpConfig {
  sites?: WpSite[]
  // Single-site shorthand (same keys as WpSite) when `sites` is omitted.
  name?: string
  path?: string
  url?: string
  wpCli?: string
  runAs?: string
  cronUser?: string
  muPluginsAllowlist?: string[]
  criticalPages?: string[]
  servicePatterns?: string[]
  refreshInterval?: number
}

// Service-account naming patterns seen in the Archpaper intrusions. Any admin
// whose login/email contains one of these (case-insensitive substring) is
// flagged for escalation even before the new-admin diff fires.
const DEFAULT_SERVICE_PATTERNS = [
  "wpsvc", "wpengine", "bot", "svc", "researchlabs", "wordpress-svc",
]

const DEFAULT_CRITICAL_PAGES = ["login", "home", "index", "front-page"]

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

// Run `wp <args>` in the site root, optionally as another OS user (WP-CLI won't
// run as root). Returns stdout, or throws — callers isolate their own failures.
async function wp(site: WpSite, args: string[], timeout = 15000): Promise<string> {
  const bin = site.wpCli || "wp"
  const full = [...args, `--path=${site.path}`]
  if (site.runAs) {
    const { stdout } = await pexec("sudo", ["-n", "-u", site.runAs, bin, ...full], { timeout, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  }
  const { stdout } = await pexec(bin, full, { timeout, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

function parseJsonSafe<T>(s: string, fallback: T): T {
  try {
    const v = JSON.parse(s)
    return v == null ? fallback : (v as T)
  } catch {
    return fallback
  }
}

async function collectSite(site: WpSite): Promise<any> {
  const label = site.name || path.basename(site.path || "") || "wordpress"
  const servicePatterns = (site.servicePatterns || DEFAULT_SERVICE_PATTERNS).map((s) => s.toLowerCase())
  const criticalPages = (site.criticalPages || DEFAULT_CRITICAL_PAGES).map((s) => s.toLowerCase())
  const out: any = { name: label, site: label, url: site.url }

  // 1. Current administrators (the rogue-admin / demotion signal set).
  try {
    const raw = await wp(site, ["user", "list", "--role=administrator", "--fields=ID,user_login,user_email,user_registered", "--format=json"])
    const admins = parseJsonSafe<any[]>(raw, []).map((u) => ({
      id: String(u.ID ?? ""),
      login: String(u.user_login ?? ""),
      email: String(u.user_email ?? ""),
      registered: u.user_registered ?? null,
    }))
    out.admins = admins
    // Service-account-pattern admins — flagged locally so they surface even on
    // the very first poll, before the server-side new-admin diff has a baseline.
    out.suspiciousAdmins = admins
      .filter((a) => servicePatterns.some((p) => a.login.toLowerCase().includes(p) || a.email.toLowerCase().includes(p)))
      .map((a) => ({ login: a.login, email: a.email, reason: "service-account naming pattern" }))
  } catch (e: any) {
    out.adminsError = String(e?.message || e).slice(0, 160)
  }

  // 2. WP core version (posture; latest-version comparison is done elsewhere).
  try {
    out.wpVersion = (await wp(site, ["core", "version"])).trim()
  } catch (e: any) {
    out.wpVersionError = String(e?.message || e).slice(0, 160)
  }

  // 3. Trashed pages/posts — attackers hid the login/home page by trashing it.
  try {
    const raw = await wp(site, ["post", "list", "--post_status=trash", "--post_type=page,post", "--fields=ID,post_title,post_name,post_type", "--format=json"])
    const trashed = parseJsonSafe<any[]>(raw, []).map((p) => ({
      id: String(p.ID ?? ""),
      title: String(p.post_title ?? ""),
      slug: String(p.post_name ?? ""),
      type: String(p.post_type ?? ""),
    }))
    out.trashedPages = trashed
    out.trashedCriticalPages = trashed.filter(
      (p) => criticalPages.includes(p.slug.toLowerCase()) || criticalPages.includes(p.title.toLowerCase()),
    )
  } catch (e: any) {
    out.trashedError = String(e?.message || e).slice(0, 160)
  }

  // 4. mu-plugins auto-load with no UI to disable them — a favorite persistence
  // spot. Report every .php and which ones aren't in the allowlist.
  try {
    const dir = path.join(site.path, "wp-content", "mu-plugins")
    const entries = await readdir(dir)
    const php = entries.filter((f) => f.toLowerCase().endsWith(".php"))
    out.muPlugins = php
    if (site.muPluginsAllowlist) {
      const allow = new Set(site.muPluginsAllowlist)
      out.unknownMuPlugins = php.filter((f) => !allow.has(f))
    }
  } catch {
    // no mu-plugins dir = fine; leave muPlugins undefined
  }

  // 5. Web user's crontab — www-data should almost never have one; the attacker
  // used it to re-drop webshells every 5 min. Non-empty = alert. Needs root; if
  // denied we report the error rather than a false "clean".
  const cronUser = site.cronUser || "www-data"
  try {
    const { stdout } = await pexec("crontab", ["-l", "-u", cronUser], { timeout: 8000 })
    const lines = stdout.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"))
    out.webUserCrontab = lines.join("\n") || null
    out.hasWebUserCrontab = lines.length > 0
    out.cronUser = cronUser
  } catch (e: any) {
    // `crontab -l` exits non-zero with "no crontab for <user>" when empty — that
    // is the healthy case, not an error. Anything else (e.g. permission) is a
    // real collection failure worth surfacing.
    const msg = String(e?.stderr || e?.message || e)
    if (/no crontab for/i.test(msg)) {
      out.webUserCrontab = null
      out.hasWebUserCrontab = false
      out.cronUser = cronUser
    } else {
      out.cronError = msg.slice(0, 160)
    }
  }

  return out
}

export function createWordpressPlugin() {
  let refreshTimer: any = null

  const sitesOf = (plugin: MonitoringPluginBase): WpSite[] => {
    const cfg = (plugin.config || {}) as WpConfig
    if (Array.isArray(cfg.sites) && cfg.sites.length) return cfg.sites
    if (cfg.path) {
      return [{
        name: cfg.name,
        path: cfg.path,
        url: cfg.url,
        wpCli: cfg.wpCli,
        runAs: cfg.runAs,
        cronUser: cfg.cronUser,
        muPluginsAllowlist: cfg.muPluginsAllowlist,
        criticalPages: cfg.criticalPages,
        servicePatterns: cfg.servicePatterns,
      }]
    }
    return []
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const sites = sitesOf(plugin)
    for (const site of sites) {
      if (!site?.path) continue
      try {
        const data = await collectSite(site)
        const uid = `wp-${slug(site.name || site.url || site.path)}`
        await plugin.send(data, uid)
      } catch (e: any) {
        const uid = `wp-${slug(site.name || site.url || site.path)}`
        await plugin.send({ name: site.name || site.path, error: String(e?.message || e).slice(0, 160) }, uid)
      }
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as WpConfig)?.refreshInterval || 300000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "wordpress",
    "wordpress",
    "WordPress security-posture monitoring plugin",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createWordpressPlugin
