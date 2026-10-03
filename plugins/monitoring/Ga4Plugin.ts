import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"
import { getJson, googleAccessToken, shiftDate, todayIn } from "./AdsensePlugin.js"

// Google Analytics 4 overview across every account and property the Google
// login can see.
//
// Runs on a user refresh token with scope analytics.readonly, minted the same
// way as the adsense plugin's (client/etc/adsense-auth.mjs --source=ga4).
//
// Each poll lists the account/property tree from the Admin API, then for each
// property asks the Data API for: active users right now (realtime), users,
// sessions and page views for today, yesterday and the last 7 days, and 30
// days of daily figures. 7-day users come from GA itself, never from summing
// days: one person on three days is one user, not three.
//
// The report carries its own 30-day history, so the server stores no history
// rows for this type. Hiding properties and nicknames live in the portal.

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta"
const DATA = "https://analyticsdata.googleapis.com/v1beta"
const DAYS = 30
// Parallel property requests. GA quotas are per property, so this only bounds
// how hard one poll hits the network.
const CONCURRENCY = 4

interface Ga4Config {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  refreshInterval?: number
  timeout?: number
}

export interface Ga4Totals { users: number; sessions: number; views: number }
const ZERO: Ga4Totals = { users: 0, sessions: 0, views: 0 }
const METRICS = [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }]

/** accountSummaries response -> accounts with their GA4 properties. */
export function parseAccounts(summaries: any[]): { id: string; name: string; properties: { id: string; name: string }[] }[] {
  return (summaries || []).map((a) => ({
    id: String(a?.account || "").replace(/^accounts\//, ""),
    name: String(a?.displayName || a?.account || ""),
    properties: (a?.propertySummaries || [])
      .filter((p: any) => !p?.propertyType || p.propertyType === "PROPERTY_TYPE_ORDINARY")
      .map((p: any) => ({ id: String(p?.property || "").replace(/^properties\//, ""), name: String(p?.displayName || p?.property || "") })),
  }))
}

const num = (v: any) => Number(v?.value) || 0
const totals = (row: any): Ga4Totals =>
  row ? { users: num(row.metricValues?.[0]), sessions: num(row.metricValues?.[1]), views: num(row.metricValues?.[2]) } : { ...ZERO }

/**
 * batchRunReports response -> the figures the portal shows.
 * Report 0: no dimensions, three named date ranges (today, yesterday, last7).
 * Report 1: one row per date over the last 30 days.
 */
export function parseProperty(batch: any, now = new Date()) {
  const [summary, byDate] = batch?.reports || []
  // A multi-range report adds a "dateRange" dimension holding each range's name.
  const range = (name: string) => totals((summary?.rows || []).find((r: any) => r?.dimensionValues?.[0]?.value === name))

  // Gap-fill the 30 days in the property's own time zone: GA leaves days with
  // no traffic out entirely.
  const today = todayIn(byDate?.metadata?.timeZone || summary?.metadata?.timeZone, now)
  const by = new Map<string, Ga4Totals>()
  for (const r of byDate?.rows || []) {
    const d = String(r?.dimensionValues?.[0]?.value || "")
    if (d.length === 8) by.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, totals(r))
  }
  const dates = Array.from({ length: DAYS }, (_, i) => shiftDate(today, i - DAYS + 1))
  const days = dates.map((d) => by.get(d) || ZERO)

  return {
    asOf: today,
    today: range("today"),
    yesterday: range("yesterday"),
    last7: range("last7"),
    daily: {
      start: dates[0],
      users: days.map((d) => d.users),
      sessions: days.map((d) => d.sessions),
      views: days.map((d) => d.views),
    },
  }
}

/** runRealtimeReport -> users active in the last 30 minutes. No rows means zero. */
export const parseRealtime = (r: any) => num(r?.rows?.[0]?.metricValues?.[0])

export const BATCH_BODY = {
  requests: [
    {
      dateRanges: [
        { startDate: "today", endDate: "today", name: "today" },
        { startDate: "yesterday", endDate: "yesterday", name: "yesterday" },
        { startDate: "6daysAgo", endDate: "today", name: "last7" },
      ],
      metrics: METRICS,
    },
    {
      dateRanges: [{ startDate: `${DAYS - 1}daysAgo`, endDate: "today" }],
      dimensions: [{ name: "date" }],
      metrics: METRICS,
      limit: DAYS + 5,
    },
  ],
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

export function createGa4Plugin() {
  let refreshTimer: any = null

  const collect = async (cfg: Ga4Config): Promise<any> => {
    const timeout = cfg.timeout || 20000
    const token = await googleAccessToken(cfg, timeout)
    const get = (url: string) => getJson(url, { headers: { Authorization: `Bearer ${token}` } }, timeout)
    const post = (url: string, body: unknown) => getJson(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeout)

    // Every account and property this login can see, across pages.
    const summaries: any[] = []
    let page = ""
    do {
      const r = await get(`${ADMIN}/accountSummaries?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`)
      summaries.push(...(r?.accountSummaries || []))
      page = r?.nextPageToken || ""
    } while (page)

    const accounts = parseAccounts(summaries)
    for (const account of accounts) {
      account.properties = await inBatches(account.properties, CONCURRENCY, async (p) => {
        // One property failing (no access to its data, quota) must not hide the rest.
        try {
          const [batch, realtime] = await Promise.all([
            post(`${DATA}/properties/${p.id}:batchRunReports`, BATCH_BODY),
            post(`${DATA}/properties/${p.id}:runRealtimeReport`, { metrics: [{ name: "activeUsers" }] }).catch(() => null),
          ])
          return { ...p, ...parseProperty(batch), activeNow: realtime ? parseRealtime(realtime) : null }
        } catch (e: any) {
          return { ...p, error: String(e?.message || e).slice(0, 160) }
        }
      }) as any
    }
    const properties = accounts.reduce((n, a) => n + a.properties.length, 0)
    return { name: "Google Analytics", accounts, properties }
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as Ga4Config
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      await plugin.send({ error: "ga4 plugin needs clientId, clientSecret and refreshToken" })
      return
    }
    try {
      await plugin.send(await collect(cfg))
    } catch (e: any) {
      await plugin.send({
        error: String(e?.message || e).slice(0, 160),
        ...(e?.code === "invalid_grant" ? { authExpired: true } : {}),
      })
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as Ga4Config)?.refreshInterval || 900000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "ga4",
    "ga4",
    "Google Analytics 4 overview (active now, users, sessions and views per property)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createGa4Plugin
