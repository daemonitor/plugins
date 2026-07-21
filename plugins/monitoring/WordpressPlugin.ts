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
  path: string // absolute WordPress root (where wp-config.php lives), IN the
               // container's namespace when `lxc` is set
  url?: string // public URL; also passed as wp --url (fixes SERVER_NAME warnings)
  wpCli?: string // wp binary (default "wp")
  runAs?: string // OS user to run wp-cli as (via sudo -u); WP-CLI refuses root
  // The site actually runs inside this LXC container (nginx reverse-proxies to
  // it). Commands are then run via `lxc exec <lxc> -- …` so wp-cli reaches the
  // container's DB (the host's wp-config points at a DB only resolvable inside).
  lxc?: string
  lxcBin?: string // lxc binary path (default "lxc"; e.g. /snap/bin/lxc on snap installs)
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
  lxc?: string
  lxcBin?: string
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

const MAXBUF = 8 * 1024 * 1024

// Run a command in the site's context — inside its LXC container when `lxc` is
// set (via `sudo -n lxc exec <c> -- …`), else on the host (optionally as
// `runAs`). Returns stdout, or throws — callers isolate their own failures.
async function execInSite(site: WpSite, argv: string[], timeout = 15000): Promise<string> {
  if (site.lxc) {
    const lxcBin = site.lxcBin || "lxc"
    const { stdout } = await pexec("sudo", ["-n", lxcBin, "exec", site.lxc, "--", ...argv], { timeout, maxBuffer: MAXBUF })
    return stdout
  }
  if (site.runAs) {
    const { stdout } = await pexec("sudo", ["-n", "-u", site.runAs, ...argv], { timeout, maxBuffer: MAXBUF })
    return stdout
  }
  const { stdout } = await pexec(argv[0], argv.slice(1), { timeout, maxBuffer: MAXBUF })
  return stdout
}

// Run `wp <args>` in the site's context. Adds:
//  --skip-plugins/--skip-themes so a plugin/theme's PHP notices don't get
//    printed onto stdout ahead of the JSON and break the parse;
//  --url when known (fixes wp-config reads of $_SERVER['SERVER_NAME']; also
//    correct for multisite);
//  --allow-root when running via `lxc exec` (that lands as root in the
//    container, and WP-CLI refuses root without it).
async function wp(site: WpSite, args: string[], timeout = 15000): Promise<string> {
  const bin = site.wpCli || "wp"
  const full = [...args, `--path=${site.path}`, "--skip-plugins", "--skip-themes"]
  if (site.url) full.push(`--url=${site.url}`)
  if (site.lxc) full.push("--allow-root")
  return execInSite(site, [bin, ...full], timeout)
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
  // spot. Report every .php and which ones aren't in the allowlist. Read via the
  // container when the site is LXC (the path is inside the container's fs).
  try {
    const dir = path.join(site.path, "wp-content", "mu-plugins")
    let entries: string[]
    if (site.lxc) {
      // `ls -1` inside the container; empty/no-dir → treat as no mu-plugins.
      const out2 = await execInSite(site, ["ls", "-1", dir], 8000).catch(() => "")
      entries = out2.split("\n").map((s) => s.trim()).filter(Boolean)
    } else {
      entries = await readdir(dir)
    }
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
  // used it to re-drop webshells every 5 min. Non-empty = alert. `crontab -u`
  // needs privilege: try direct first, then `sudo -n` (the agent user typically
  // has passwordless sudo). "no crontab for <user>" is the HEALTHY empty case,
  // not an error — anything else (still denied) is a real collection failure.
  const cronUser = site.cronUser || "www-data"
  const readCron = async (): Promise<string> => {
    // LXC: the web user's crontab lives INSIDE the container (that's where the
    // persistence would be dropped), so read it there.
    if (site.lxc) {
      try {
        return await execInSite(site, ["crontab", "-l", "-u", cronUser], 8000)
      } catch (e2: any) {
        const msg = String(e2?.stderr || e2?.message || "")
        // "no crontab for" = empty (healthy). "cannot use this program" /
        // "not allowed to use" = the user is denied crontab entirely
        // (cron.deny / not in cron.allow) — that's GOOD posture (can't be used
        // for persistence), not a collection failure. Treat both as clean.
        if (/no crontab for|cannot use this program|not allowed to use/i.test(msg)) return ""
        throw e2
      }
    }
    try {
      return (await pexec("crontab", ["-l", "-u", cronUser], { timeout: 8000 })).stdout
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || "")
      if (/no crontab for/i.test(msg)) return "" // empty is fine
      if (/privileged|not permitted|not allowed|denied/i.test(msg)) {
        // Retry under sudo; may itself throw "no crontab for" (empty) → catch.
        try {
          return (await pexec("sudo", ["-n", "crontab", "-l", "-u", cronUser], { timeout: 8000 })).stdout
        } catch (e2: any) {
          if (/no crontab for/i.test(String(e2?.stderr || e2?.message || ""))) return ""
          throw e2
        }
      }
      throw e
    }
  }
  try {
    const stdout = await readCron()
    const lines = stdout.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"))
    out.webUserCrontab = lines.join("\n") || null
    out.hasWebUserCrontab = lines.length > 0
    out.cronUser = cronUser
  } catch (e: any) {
    out.cronError = String(e?.stderr || e?.message || e).slice(0, 160)
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
        lxc: cfg.lxc,
        lxcBin: cfg.lxcBin,
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
