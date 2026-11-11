import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"
import { failure, getJson, googleAccessToken, shiftDate } from "./AdsensePlugin.js"

// Google Workspace pooled storage: used against the domain's shared quota,
// split by Drive, Gmail and Photos, from the Admin SDK customer usage report.
//
// Runs on the same `workspace` config block the cost plugin's workspace
// provider uses (clientId, clientSecret, refreshToken, customerId), minted by
// client/etc/google-auth.mjs --source=workspace with the reports scope.
//
// Google publishes the report a day or more late, so each poll walks back from
// yesterday to the newest date that has data. `asOf` says which day it is.
// The same day's users report lists each account's share, biggest first.
//
// The pool comes from the licenses assigned right now (seats x storage per
// seat), not from the report, so a licence change shows within one poll. The
// report's pool is days old: on 2026-11-05 it said 3.45 TB while the Admin
// console already counted 19 TB. A SKU with no known size falls back to the
// report's figure; `storagePerSeatGiB` sets one by SKU id.

const API = "https://admin.googleapis.com/admin/reports/v1/usage/dates"
const USERS_API = "https://admin.googleapis.com/admin/reports/v1/usage/users/all/dates"
const USER_PARAMS = ["used_quota_in_mb", "drive_used_quota_in_mb", "gmail_used_quota_in_mb", "gplus_photos_used_quota_in_mb"]
const LICENSES = "https://licensing.googleapis.com/apps/licensing/v1/product/Google-Apps/users"
const LOOKBACK = 7
const GiB = 1024 ** 3
// Pooled storage each seat adds, in GiB (Google sells it in binary units).
export const STORAGE_PER_SEAT: Record<string, number> = {
  "1010020027": 30, // Business Starter
  "1010020028": 2048, // Business Standard
  "1010020025": 5120, // Business Plus
  "1010020026": 5120, // Enterprise Standard
  "1010020020": 5120, // Enterprise Plus
}
// ponytail: the biggest accounts only, so a large domain's report stays small.
const MAX_USERS = 200

interface WorkspaceConfig {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  customerId?: string
  warnPct?: number
  critPct?: number
  /** Storage per seat in GiB by SKU id, for a plan STORAGE_PER_SEAT doesn't know. */
  storagePerSeatGiB?: Record<string, number>
  refreshInterval?: number
  timeout?: number
}

/** A customer usage report -> MB figures by parameter name. Null when the day has no data yet. */
export function parseUsage(body: any): Record<string, number> | null {
  const params: any[] = body?.usageReports?.[0]?.parameters || []
  const out: Record<string, number> = {}
  for (const p of params) {
    const name = String(p?.name || "")
    if (name.startsWith("accounts:") && p.intValue != null) out[name.slice(9)] = Number(p.intValue)
  }
  return out.used_quota_in_mb != null ? out : null
}

const MB = 1024 * 1024

export interface WorkspaceUser { email: string; bytes: number; drive: number; gmail: number; photos: number }

/** A users usage report page -> each user's storage in bytes. */
export function parseUsers(body: any): WorkspaceUser[] {
  return (body?.usageReports || []).flatMap((r: any) => {
    const email = String(r?.entity?.userEmail || "")
    if (!email) return []
    const v: Record<string, number> = {}
    for (const p of r?.parameters || []) v[String(p?.name || "").replace(/^accounts:/, "")] = Number(p?.intValue) || 0
    return [{ email, bytes: (v.used_quota_in_mb || 0) * MB, drive: (v.drive_used_quota_in_mb || 0) * MB, gmail: (v.gmail_used_quota_in_mb || 0) * MB, photos: (v.gplus_photos_used_quota_in_mb || 0) * MB }]
  })
}

/** MB figures -> what the report carries. A total of 0 or less means Google reports no pooled cap. */
export function summarize(u: Record<string, number>, asOf: string) {
  const total = u.total_quota_in_mb > 0 ? u.total_quota_in_mb * MB : null
  const used = u.used_quota_in_mb * MB
  return {
    asOf,
    usedBytes: used,
    totalBytes: total,
    usedPct: total ? Math.round((used / total) * 1000) / 10 : null,
    breakdown: [
      { name: "Drive", bytes: (u.drive_used_quota_in_mb || 0) * MB },
      { name: "Gmail", bytes: (u.gmail_used_quota_in_mb || 0) * MB },
      { name: "Photos", bytes: (u.gplus_photos_used_quota_in_mb || 0) * MB },
    ],
  }
}

export interface Seats { sku: string; name: string; count: number }

/** Licence assignments -> seat counts per SKU. */
export function countSeats(items: any[]): Seats[] {
  const by = new Map<string, Seats>()
  for (const a of items) {
    const sku = String(a?.skuId || "")
    const s = by.get(sku) || { sku, name: String(a?.skuName || sku).replace(/^Google Workspace /, ""), count: 0 }
    s.count++
    by.set(sku, s)
  }
  return [...by.values()].sort((a, b) => b.count - a.count)
}

/** Seats -> pooled storage in bytes, or null when a SKU's size is unknown. */
export function poolBytes(seats: Seats[], overrides: Record<string, number> = {}): number | null {
  let total = 0
  for (const s of seats) {
    const gib = overrides[s.sku] ?? STORAGE_PER_SEAT[s.sku]
    if (gib == null) return null
    total += s.count * gib * GiB
  }
  return seats.length ? total : null
}

export function createWorkspacePlugin() {
  let refreshTimer: any = null

  const collect = async (cfg: WorkspaceConfig) => {
    const timeout = cfg.timeout || 20000
    const auth = { headers: { Authorization: `Bearer ${await googleAccessToken(cfg, timeout)}` } }
    const today = new Date().toISOString().slice(0, 10)

    // The pool as licensed right now. If this fails, the report's pool stands in.
    let seats: Seats[] | undefined
    try {
      const items: any[] = []
      let page = ""
      do {
        const q = new URLSearchParams({ customerId: cfg.customerId!, maxResults: "1000", ...(page ? { pageToken: page } : {}) })
        const r = await getJson(`${LICENSES}?${q}`, auth, timeout)
        items.push(...(r?.items || []))
        page = r?.nextPageToken || ""
      } while (page)
      seats = countSeats(items)
    } catch { /* report pool */ }
    const licensed = seats ? poolBytes(seats, cfg.storagePerSeatGiB) : null

    for (let back = 1; back <= LOOKBACK; back++) {
      const date = shiftDate(today, -back)
      // No `parameters` filter: one misspelt name fails the whole call.
      // A day Google hasn't published is a 400 ("Data for dates later than X is not yet available").
      const body = await getJson(`${API}/${date}?customerId=${encodeURIComponent(cfg.customerId!)}`, auth, timeout)
        .catch((e) => { if (/not yet available/i.test(String(e?.message))) return null; throw e })
      const u = parseUsage(body)
      if (!u) continue
      // Per-user storage is extra: if it fails, the domain totals still report.
      let users: WorkspaceUser[] | undefined
      try {
        const all: WorkspaceUser[] = []
        let page = ""
        do {
          const q = new URLSearchParams({
            customerId: cfg.customerId!, maxResults: "1000",
            parameters: USER_PARAMS.map((p) => `accounts:${p}`).join(","),
            ...(page ? { pageToken: page } : {}),
          })
          const r = await getJson(`${USERS_API}/${date}?${q}`, auth, timeout)
          all.push(...parseUsers(r))
          page = r?.nextPageToken || ""
        } while (page)
        users = all.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_USERS)
      } catch { /* totals only */ }
      const s = summarize(u, date)
      if (licensed) Object.assign(s, { totalBytes: licensed, usedPct: Math.round((s.usedBytes / licensed) * 1000) / 10 })
      return {
        name: "Workspace storage", warnPct: cfg.warnPct ?? 85, critPct: cfg.critPct ?? 95, ...s,
        poolFrom: licensed ? "licenses" : "report", seats, users,
      }
    }
    throw new Error(`no usage report in the last ${LOOKBACK} days`)
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as WorkspaceConfig
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken || !cfg.customerId) {
      await plugin.send({ error: "workspace plugin needs clientId, clientSecret, refreshToken and customerId" })
      return
    }
    try {
      await plugin.send(await collect(cfg))
    } catch (e: any) {
      await plugin.send(failure(e))
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as WorkspaceConfig)?.refreshInterval || 900000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "workspace",
    "workspace",
    "Google Workspace pooled storage (used of shared quota, by Drive, Gmail, Photos)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createWorkspacePlugin
