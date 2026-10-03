import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// Google AdSense earnings monitor.
//
// AdSense has no service-account access, so this runs on a user refresh token
// (scope adsense.readonly) minted once by hand. Each poll trades it for a
// one-hour access token and pulls ONE report: earnings and page views per day,
// from whichever is earlier of the 1st of the month or 29 days ago, through
// today. Every figure on the tile (today, yesterday, 7 days, month to date, RPM,
// the daily sparkline) is summed locally from those rows, so the numbers cannot
// disagree with each other the way separate report calls can mid-update.
//
// Dates are the ACCOUNT's time zone, not this host's: "today" for an account in
// New York is still yesterday on a UTC box for a few hours every night.

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const API = "https://adsense.googleapis.com/v2"

interface AdsenseConfig {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  /** "accounts/pub-…". Only needed when the token can see more than one account. */
  accountId?: string
  refreshInterval?: number
  timeout?: number
}

export interface AdsenseDay { date: string; earnings: number; pageViews: number; clicks: number }

/** YYYY-MM-DD shifted by whole days. */
export function shiftDate(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + days)
  return t.toISOString().slice(0, 10)
}

/** Today's date as the account sees it. */
export function todayIn(timeZone: string | undefined, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC" }).format(now)
}

/** Earlier of the 1st of this month and 29 days back, so one report covers both windows. */
export function reportStart(today: string): string {
  const monthStart = `${today.slice(0, 7)}-01`
  const back = shiftDate(today, -29)
  return back < monthStart ? back : monthStart
}

export function reportUrl(account: string, start: string, end: string, bySite = false): string {
  const q = new URLSearchParams({ dateRange: "CUSTOM", reportingTimeZone: "ACCOUNT_TIME_ZONE", dimensions: "DATE" })
  // DOMAIN_NAME, not OWNED_SITE_DOMAIN_NAME: the owned-site rows nest (archpaper.com
  // contains www.archpaper.com and jobs.archpaper.com), so they double count.
  if (bySite) q.append("dimensions", "DOMAIN_NAME")
  for (const [k, v] of [["startDate", start], ["endDate", end]]) {
    const [y, m, d] = v.split("-").map(Number)
    q.set(`${k}.year`, String(y))
    q.set(`${k}.month`, String(m))
    q.set(`${k}.day`, String(d))
  }
  q.append("metrics", "ESTIMATED_EARNINGS")
  q.append("metrics", "PAGE_VIEWS")
  q.append("metrics", "CLICKS")
  return `${API}/${account}/reports:generate?${q}`
}

/** reports:generate response -> per-day rows. Columns are found by header name, not position. */
export function parseReport(report: any): { currency: string; days: AdsenseDay[] } {
  const headers: any[] = Array.isArray(report?.headers) ? report.headers : []
  const col = (name: string) => headers.findIndex((h) => h?.name === name)
  const [iDate, iEarn, iViews, iClicks] = [col("DATE"), col("ESTIMATED_EARNINGS"), col("PAGE_VIEWS"), col("CLICKS")]
  if (iDate < 0 || iEarn < 0) throw new Error("unexpected report shape (no DATE/ESTIMATED_EARNINGS column)")
  // A day with no traffic has no row at all, so an empty report is valid.
  const rows: any[] = Array.isArray(report?.rows) ? report.rows : []
  return {
    currency: headers[iEarn]?.currencyCode || "USD",
    days: rows.map((r) => ({
      date: String(r?.cells?.[iDate]?.value || ""),
      earnings: Number(r?.cells?.[iEarn]?.value) || 0,
      pageViews: iViews < 0 ? 0 : Number(r?.cells?.[iViews]?.value) || 0,
      clicks: iClicks < 0 ? 0 : Number(r?.cells?.[iClicks]?.value) || 0,
    })),
  }
}

/** A DATE x DOMAIN_NAME report -> per-day rows keyed by site (hostname without a leading www). */
export function parseSiteReport(report: any): Map<string, AdsenseDay[]> {
  const headers: any[] = Array.isArray(report?.headers) ? report.headers : []
  const iDomain = headers.findIndex((h) => h?.name === "DOMAIN_NAME")
  const out = new Map<string, AdsenseDay[]>()
  if (iDomain < 0) return out
  const { days } = parseReport(report)
  const rows: any[] = Array.isArray(report?.rows) ? report.rows : []
  rows.forEach((r, i) => {
    // www.example.com and example.com are one site to a reader, so they merge.
    const domain = String(r?.cells?.[iDomain]?.value || "").replace(/^www\./, "")
    if (!domain) return
    if (!out.has(domain)) out.set(domain, [])
    const list = out.get(domain)!
    const same = list.find((d) => d.date === days[i].date)
    if (same) {
      same.earnings += days[i].earnings
      same.pageViews += days[i].pageViews
      same.clicks += days[i].clicks
    } else list.push({ ...days[i] })
  })
  return out
}

const MAX_SITES = 20

/**
 * Per-site figures, biggest earner first. Domains that earned nothing in the
 * window are dropped: AdSense lists every hostname an ad tag loaded on, which
 * includes admin hosts and previews that are noise here. `daily` is earnings
 * only, to keep the payload small.
 */
export function summarizeSites(bySite: Map<string, AdsenseDay[]>, today: string) {
  return [...bySite.entries()]
    .map(([domain, days]) => {
      const sum = summarize(days, today)
      return { domain, ...sum, daily: sum.daily.map((d) => cents(d.earnings)), window: days.reduce((t, d) => t + d.earnings, 0) }
    })
    .filter((s) => s.window > 0)
    .sort((a, b) => b.window - a.window)
    .slice(0, MAX_SITES)
    .map(({ window: _window, ...site }) => site)
}

const cents = (n: number) => Math.round(n * 100) / 100

/** Roll per-day rows up into the figures the tile shows. `last7` includes today, as AdSense's own "Last 7 days" does. */
export function summarize(days: AdsenseDay[], today: string) {
  const by = new Map(days.map((d) => [d.date, d]))
  const day = (date: string): AdsenseDay => by.get(date) || { date, earnings: 0, pageViews: 0, clicks: 0 }
  const span = (n: number) => Array.from({ length: n }, (_, i) => day(shiftDate(today, i - n + 1)))
  const week = span(7)
  const last7 = week.reduce((s, d) => s + d.earnings, 0)
  const pageViews7 = week.reduce((s, d) => s + d.pageViews, 0)
  const month = today.slice(0, 7)
  return {
    today: cents(day(today).earnings),
    yesterday: cents(day(shiftDate(today, -1)).earnings),
    last7: cents(last7),
    monthToDate: cents(days.filter((d) => d.date.startsWith(month)).reduce((s, d) => s + d.earnings, 0)),
    pageViews7,
    clicks7: week.reduce((s, d) => s + d.clicks, 0),
    // Page RPM over the same 7 days: earnings per thousand page views.
    rpm: pageViews7 ? cents((last7 / pageViews7) * 1000) : 0,
    // Gap-filled so the sparkline has one point per day, oldest first.
    daily: span(30),
  }
}

export async function getJson(url: string, init: RequestInit, timeout: number): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e: any = new Error(body?.error_description || body?.error?.message || body?.error || `HTTP ${res.status}`)
    e.code = typeof body?.error === "string" ? body.error : body?.error?.status
    throw e
  }
  return body
}

/** Trade a refresh token for a one-hour access token. Shared with the ga4 plugin. */
export async function googleAccessToken(
  cfg: { clientId?: string; clientSecret?: string; refreshToken?: string },
  timeout: number,
): Promise<string> {
  const tok = await getJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId || "",
      client_secret: cfg.clientSecret || "",
      refresh_token: cfg.refreshToken || "",
    }).toString(),
  }, timeout)
  return tok.access_token
}

export function createAdsensePlugin() {
  let refreshTimer: any = null
  // Resolved once: the account and its time zone do not change between polls.
  let account: { name: string; displayName?: string; timeZone?: string } | null = null

  const collect = async (cfg: AdsenseConfig): Promise<any> => {
    const timeout = cfg.timeout || 15000
    const auth = { headers: { Authorization: `Bearer ${await googleAccessToken(cfg, timeout)}` } }

    if (!account) {
      const list: any[] = (await getJson(`${API}/accounts`, auth, timeout))?.accounts || []
      const a = cfg.accountId ? list.find((x) => x.name === cfg.accountId) : list[0]
      if (!a) throw new Error(cfg.accountId ? `account ${cfg.accountId} not visible to this token` : "no AdSense account visible to this token")
      account = { name: a.name, displayName: a.displayName, timeZone: a.timeZone?.id }
    }

    const today = todayIn(account.timeZone)
    const start = reportStart(today)
    const { currency, days } = parseReport(await getJson(reportUrl(account.name, start, today), auth, timeout))
    // The per-site breakdown is extra: if it fails, the account totals still report.
    let sites: ReturnType<typeof summarizeSites> = []
    try {
      sites = summarizeSites(parseSiteReport(await getJson(reportUrl(account.name, start, today, true), auth, timeout)), today)
    } catch { /* totals only */ }
    return {
      // The account's own name ("The Architect's Newspaper") labels the service.
      // It overrides the plugin's instance name, which only says "AdSense".
      ...(account.displayName ? { name: account.displayName } : {}),
      accountId: account.name,
      currency,
      asOf: today,
      ...summarize(days, today),
      sites,
    }
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as AdsenseConfig
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      await plugin.send({ error: "adsense plugin needs clientId, clientSecret and refreshToken" })
      return
    }
    try {
      await plugin.send(await collect(cfg))
    } catch (e: any) {
      // invalid_grant = the refresh token was revoked or expired. Nothing the
      // next poll can fix, so it is flagged apart from a transient API error.
      await plugin.send({
        error: String(e?.message || e).slice(0, 160),
        ...(e?.code === "invalid_grant" ? { authExpired: true } : {}),
      })
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    // AdSense figures lag by hours, so 15 minutes loses nothing. The server
    // allows these rows 30 minutes of silence before calling them offline.
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as AdsenseConfig)?.refreshInterval || 900000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "adsense",
    "adsense",
    "Google AdSense earnings (today, yesterday, 7 days, month to date, page RPM)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createAdsensePlugin
