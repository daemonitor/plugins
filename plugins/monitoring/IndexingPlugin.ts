import { readFile, writeFile } from "node:fs/promises"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"
import {
  SCOPES, accessToken, inspectUrl, isStuck, parseKey, parseSitemap, urlMetadata,
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
// URLs come from `urls` and the newest `sitemapLimit` entries of `sitemap`
// (a urlset, not a sitemap index). A URL's clock starts at the earlier of its
// sitemap lastmod and the first poll that saw it, kept in `stateFile` so a
// restart doesn't reset it.
//
// Quota: URL Inspection allows 2000 a day and 600 a minute per property. 25
// URLs every 6 hours is 100 a day.

interface IndexingConfig {
  /** Path to the service account JSON key. */
  keyFile?: string
  /** Search Console property: "sc-domain:example.com" or "https://example.com/". */
  site?: string
  urls?: string[]
  sitemap?: string | string[]
  sitemapLimit?: number
  staleHours?: number
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

export function createIndexingPlugin() {
  let refreshTimer: any = null

  const collect = async (cfg: IndexingConfig): Promise<any> => {
    const timeout = cfg.timeout || 20000
    const f: typeof fetch = (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(timeout) })
    const key = parseKey(await readFile(cfg.keyFile!, "utf8"))

    const listed = new Map<string, string | undefined>()
    for (const u of cfg.urls || []) listed.set(u, undefined)
    for (const sm of ([] as string[]).concat(cfg.sitemap || [])) {
      const res = await f(sm)
      if (!res.ok) throw new Error(`sitemap ${sm}: HTTP ${res.status}`)
      for (const e of parseSitemap(await res.text()).slice(0, cfg.sitemapLimit || 25)) listed.set(e.url, e.lastmod)
    }

    const stateFile = cfg.stateFile || `${process.env.HOME || "."}/.config/daemonitor/indexing-state.json`
    const seen = await loadState(stateFile)
    const now = new Date().toISOString()
    const state: Record<string, string> = {}
    for (const [u, lastmod] of listed) {
      const first = seen[u] || now
      state[u] = lastmod && Date.parse(lastmod) < Date.parse(first) ? new Date(lastmod).toISOString() : first
    }
    // Only listed URLs are kept, so a job that leaves the sitemap drops out.
    await writeFile(stateFile, JSON.stringify(state)).catch(() => {})

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
      name: (cfg as any).name || `Indexing · ${cfg.site}`,
      site: cfg.site,
      staleHours: cfg.staleHours || 72,
      intervalMs: cfg.refreshInterval || 21_600_000,
      checked: urls.length,
      indexed: urls.filter((u) => u.verdict === "PASS").length,
      stuck: urls.filter((u) => u.stuck).length,
      urls,
    }
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as IndexingConfig
    if (!cfg.keyFile || !cfg.site) {
      await plugin.send({ error: "indexing plugin needs keyFile and site" })
      return
    }
    try {
      await plugin.send(await collect(cfg))
    } catch (e: any) {
      await plugin.send({
        site: cfg.site,
        intervalMs: cfg.refreshInterval || 21_600_000,
        error: String(e?.message || e).slice(0, 160),
        ...(e?.status === 401 || e?.status === 403 || e?.code === "invalid_grant" ? { authExpired: true } : {}),
      })
    }
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
