import { readFile, writeFile } from "node:fs/promises"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"
import {
  SCOPES, accessToken, inspectUrl, isStuck, parseKey, parseSitemap, parseSitemapIndex, urlMetadata,
  type Inspection, type NotifyMetadata,
} from "./googleIndexing.js"

// Whether Google has indexed a list of URLs, from Search Console URL Inspection
// on a service account.
//
// Publishing to the Indexing API returns 200 even when Google records nothing,
// so a submit button proves little. This checks the outcome instead: each poll
// inspects every URL (coverage state, last crawl, fetch state, Google's
// canonical) and reads its Indexing API notify history. The server raises one
// alert per URL still not indexed `staleHours` after it appeared, and closes it
// once Google indexes the page.
//
// Each entry in `sites` is its own service (one card, one page, one group
// membership), sharing the key, the property and the state file. Without
// `sites`, the plugin's own config is the one site.
//
// A site's URLs come from `urls` and the newest `sitemapLimit` entries of
// `sitemap`: a urlset, or a sitemap index, in which case the `sitemapChildren`
// (default 3) most recently changed child sitemaps matching `sitemapMatch` are read. A URL's clock
// starts at the earlier of its sitemap lastmod and the first poll that saw it,
// kept in `stateFile` so a restart doesn't reset it.
//
// Quota: URL Inspection allows 2000 a day and 600 a minute per property. 25
// URLs every 6 hours is 100 a day per site.

interface SiteConfig {
  name?: string
  /** The service's id. Keep it once set: alerts and group membership hang on it. */
  uniqueId?: string
  urls?: string[]
  sitemap?: string | string[]
  sitemapLimit?: number
  sitemapChildren?: number
  /** Regex a child sitemap's URL must match, e.g. "post-sitemap" to skip category and author sitemaps. */
  sitemapMatch?: string
  staleHours?: number
  /**
   * Skip certificate checks on the sitemap fetch only (Bun's fetch). For an
   * agent whose hosts file points the site at a local server with another
   * name's certificate. Google calls are always verified.
   */
  insecureTls?: boolean
}

interface IndexingConfig extends SiteConfig {
  /** Path to the service account JSON key. */
  keyFile?: string
  /** Search Console property: "sc-domain:example.com" or "https://example.com/". */
  site?: string
  sites?: SiteConfig[]
  /**
   * Report under a system of its own instead of the agent's: the tenant's
   * clientstate URL and a file holding that system's key. Without it, reports
   * go out through the agent's connector like every other plugin's.
   */
  report?: { apiUrl: string; systemKeyFile: string }
  stateFile?: string
  refreshInterval?: number
  timeout?: number
}

export interface IndexedUrl extends Inspection {
  since: string
  stuck: boolean
  notify?: NotifyMetadata | null
  error?: string
}

async function loadState(file: string): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(file, "utf8")) } catch { return {} }
}

const slug = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)

export function createIndexingPlugin() {
  let refreshTimer: any = null

  const sitesOf = (cfg: IndexingConfig, plugin: MonitoringPluginBase): SiteConfig[] =>
    cfg.sites?.length
      ? cfg.sites.map((s) => ({ ...s, uniqueId: s.uniqueId || `indexing-${slug(s.name || String(([] as string[]).concat(s.sitemap || s.urls || "site")[0]))}` }))
      : [{ ...cfg, name: cfg.name || plugin.instanceName, uniqueId: plugin.uniqueId }]

  const collectSite = async (cfg: IndexingConfig, s: SiteConfig, state: Record<string, string>, seen: Record<string, string>) => {
    const timeout = cfg.timeout || 20000
    const f: typeof fetch = (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(timeout) })
    const getText = async (u: string) => {
      const res = await fetch(u, { signal: AbortSignal.timeout(timeout), ...(s.insecureTls ? { tls: { rejectUnauthorized: false } } : {}) } as any)
      if (!res.ok) throw new Error(`sitemap ${u}: HTTP ${res.status}`)
      return res.text()
    }
    const key = parseKey(await readFile(cfg.keyFile!, "utf8"))

    const listed = new Map<string, string | undefined>()
    for (const u of s.urls || []) listed.set(u, undefined)
    for (const sm of ([] as string[]).concat(s.sitemap || [])) {
      const xml = await getText(sm)
      const children = parseSitemapIndex(xml).filter((c) => !s.sitemapMatch || new RegExp(s.sitemapMatch).test(c.url)).slice(0, s.sitemapChildren || 3)
      const entries = children.length
        ? (await Promise.all(children.map((c) => getText(c.url)))).flatMap(parseSitemap)
        : parseSitemap(xml)
      entries.sort((a, b) => (Date.parse(b.lastmod || "") || 0) - (Date.parse(a.lastmod || "") || 0))
      for (const e of entries.slice(0, s.sitemapLimit || 25)) listed.set(e.url, e.lastmod)
    }

    const now = new Date().toISOString()
    for (const [u, lastmod] of listed) {
      const first = seen[u] || now
      state[u] = lastmod && Date.parse(lastmod) < Date.parse(first) ? new Date(lastmod).toISOString() : first
    }

    const [inspectTok, indexTok] = await Promise.all([
      accessToken(key, [SCOPES.inspect], f),
      accessToken(key, [SCOPES.indexing], f),
    ])
    const urls: IndexedUrl[] = []
    // One at a time: a few dozen URLs every few hours needs no concurrency.
    for (const u of listed.keys()) {
      try {
        const [i, notify] = await Promise.all([
          inspectUrl(inspectTok, u, cfg.site!, f),
          urlMetadata(indexTok, u, f).catch(() => undefined),
        ])
        urls.push({ ...i, since: state[u], stuck: isStuck(i.coverageState), ...(notify !== undefined ? { notify } : {}) })
      } catch (e: any) {
        // A 403 or 429 will say the same for every URL: stop and report it once.
        if (e?.status === 401 || e?.status === 403 || e?.status === 429) throw e
        urls.push({ url: u, verdict: "", coverageState: "", since: state[u], stuck: false, error: String(e?.message || e).slice(0, 160) })
      }
    }
    return {
      ...(s.name ? { name: s.name } : {}),
      site: cfg.site,
      staleHours: s.staleHours || cfg.staleHours || 72,
      intervalMs: cfg.refreshInterval || 21_600_000,
      checked: urls.length,
      indexed: urls.filter((u) => u.verdict === "PASS").length,
      stuck: urls.filter((u) => u.stuck).length,
      urls,
    }
  }

  const sender = async (cfg: IndexingConfig, plugin: MonitoringPluginBase) => {
    if (!cfg.report) return (data: any, uid?: string) => plugin.send(data, uid)
    let key = ""
    try { key = (await readFile(cfg.report.systemKeyFile, "utf8")).trim() } catch {}
    // No key, no own system: report through the agent so the failure shows somewhere.
    if (!key) {
      console.error(`indexing: can't read ${cfg.report.systemKeyFile}, reporting through the agent instead`)
      return (data: any, uid?: string) => plugin.send(data, uid)
    }
    return async (data: any, uid?: string) => {
      try {
        const res = await fetch(cfg.report!.apiUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-System-Key": key, "X-Unique-Id": uid || plugin.uniqueId, "X-Type": "indexing" },
          body: JSON.stringify({ name: plugin.instanceName, ...data }),
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) console.error(`indexing: report rejected, HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`)
      } catch (e: any) {
        console.error("indexing: report failed:", e?.message || e)
      }
    }
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as IndexingConfig
    const sites = sitesOf(cfg, plugin)
    const send = await sender(cfg, plugin)
    if (!cfg.keyFile || !cfg.site) {
      for (const s of sites) await send({ ...(s.name ? { name: s.name } : {}), error: "indexing plugin needs keyFile and site" }, s.uniqueId)
      return
    }
    const stateFile = cfg.stateFile || `${process.env.HOME || "."}/.config/daemonitor/indexing-state.json`
    const seen = await loadState(stateFile)
    // Only URLs some site still lists are kept, so a page that leaves a sitemap drops out.
    const state: Record<string, string> = {}
    for (const s of sites) {
      try {
        await send(await collectSite(cfg, s, state, seen), s.uniqueId)
      } catch (e: any) {
        // Keep the failed site's clocks: its URLs didn't leave, the fetch did.
        for (const [u, t] of Object.entries(seen)) if (!(u in state)) state[u] = t
        await send({
          ...(s.name ? { name: s.name } : {}),
          site: cfg.site,
          intervalMs: cfg.refreshInterval || 21_600_000,
          error: String(e?.message || e).slice(0, 160),
          ...(e?.status === 401 || e?.status === 403 || e?.code === "invalid_grant" ? { authExpired: true } : {}),
        }, s.uniqueId)
      }
    }
    await writeFile(stateFile, JSON.stringify(state)).catch(() => {})
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as IndexingConfig)?.refreshInterval || 21_600_000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "indexing",
    "indexing",
    "Google indexing of a list of URLs (Search Console URL Inspection, Indexing API notify history)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createIndexingPlugin
