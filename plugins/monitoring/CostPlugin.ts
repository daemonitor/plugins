import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"
import { PROVIDERS } from "./CostProviders.js"

// Spend monitor: what a service bills you, per provider, as one row each.
//
// One plugin, many providers. Each entry in `providers` is polled and reported
// under its own unique id (`cost-<id>`), so OpenAI, AWS and an ad account sit on
// the board as separate rows. A provider fetcher returns a daily series where
// the API has one, or only a month-to-date figure where it doesn't (invoice-
// level APIs). Every number on the row is derived here from that one fetch, so
// MTD, yesterday and the projection cannot disagree with each other.
//
// Dates are UTC. Every billing API we read buckets by UTC day.

export interface CostDay { date: string; amount: number }

/** What a provider fetcher returns. `days` when the API has daily buckets, else `monthToDate`. */
export interface CostFetch {
  currency: string
  days?: CostDay[]
  monthToDate?: number
  /** Month-to-date spend split by line item (model, service, campaign), biggest first. */
  breakdown?: { name: string; amount: number }[]
}

export interface CostProviderConfig {
  provider: string
  /** Distinguishes two accounts on one provider. Defaults to the provider name. */
  id?: string
  name?: string
  /** Monthly budget in the account currency. Projected over = warning, MTD over = error. */
  budget?: number
  /** Yesterday above this multiple of the prior 7-day average is a spike. Default 3. */
  spikeFactor?: number
  timeout?: number
  [key: string]: any
}

interface CostConfig {
  refreshInterval?: number
  providers?: CostProviderConfig[]
}

const DEFAULT_INTERVAL = 3600000

const round2 = (n: number) => Math.round(n * 100) / 100

export function shiftDate(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + days)
  return t.toISOString().slice(0, 10)
}

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10)

/** Earlier of the 1st of this month and 29 days back: one fetch covers the month and a 30-day trace. */
export function fetchStart(today: string): string {
  const monthStart = `${today.slice(0, 7)}-01`
  const back = shiftDate(today, -29)
  return back < monthStart ? back : monthStart
}

export function daysInMonth(today: string): number {
  const [y, m] = today.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function summarizeCost(f: CostFetch, today: string) {
  const month = today.slice(0, 7)
  const dom = Number(today.slice(8, 10))
  const dim = daysInMonth(today)
  if (!f.days) {
    // ponytail: straight-line projection from MTD over elapsed days; today's
    // partial day drags it low early in the month. Fine for an invoice-level API.
    const mtd = Number(f.monthToDate) || 0
    return { monthToDate: round2(mtd), projected: round2((mtd / dom) * dim), daily: [] as CostDay[] }
  }
  const by = new Map<string, number>()
  for (const d of f.days) by.set(d.date, (by.get(d.date) || 0) + (Number(d.amount) || 0))
  const at = (date: string) => by.get(date) || 0
  // Gap-filled, oldest first, one point per day for the trace.
  const daily: CostDay[] = []
  for (let i = 29; i >= 0; i--) {
    const date = shiftDate(today, -i)
    daily.push({ date, amount: round2(at(date)) })
  }
  let mtd = 0
  for (const [date, amount] of by) if (date.startsWith(month) && date <= today) mtd += amount
  const todayAmt = at(today)
  // Project from COMPLETE days only: today is still filling in, and on the 1st
  // there is nothing complete yet, so fall back to the partial day.
  const projected = dom > 1 ? ((mtd - todayAmt) / (dom - 1)) * dim : mtd * dim
  // The 7 complete days before yesterday, the baseline a spike is judged against.
  let prior = 0
  for (let i = 2; i <= 8; i++) prior += at(shiftDate(today, -i))
  return {
    monthToDate: round2(mtd),
    projected: round2(projected),
    today: round2(todayAmt),
    yesterday: round2(at(shiftDate(today, -1))),
    avg7: round2(prior / 7),
    last30: round2(daily.reduce((s, d) => s + d.amount, 0)),
    daily,
  }
}

export async function collectCost(p: CostProviderConfig, today = todayUtc()) {
  const fetcher = PROVIDERS[p.provider]
  if (!fetcher) throw new Error(`unknown cost provider "${p.provider}" (have: ${Object.keys(PROVIDERS).join(", ")})`)
  const f = await fetcher(p, { start: fetchStart(today), end: today }, p.timeout || 20000)
  return {
    currency: (f.currency || "USD").toUpperCase(),
    asOf: today,
    ...summarizeCost(f, today),
    breakdown: (f.breakdown || []).filter((b) => b.amount).sort((a, b) => b.amount - a.amount).slice(0, 12)
      .map((b) => ({ name: b.name, amount: round2(b.amount) })),
  }
}

export function createCostPlugin() {
  let refreshTimer: any = null

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as CostConfig
    const intervalMs = cfg.refreshInterval || DEFAULT_INTERVAL
    for (const p of cfg.providers || []) {
      const id = p.id || p.provider
      const meta = {
        name: p.name || p.provider,
        provider: p.provider,
        intervalMs,
        ...(p.budget ? { budget: Number(p.budget) } : {}),
        ...(p.spikeFactor ? { spikeFactor: Number(p.spikeFactor) } : {}),
      }
      try {
        await plugin.send({ ...meta, ...(await collectCost(p)) }, `cost-${id}`)
      } catch (e: any) {
        await plugin.send({
          ...meta,
          error: String(e?.message || e).slice(0, 160),
          ...(e?.status === 401 || e?.status === 403 ? { authExpired: true } : {}),
        }, `cost-${id}`)
      }
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as CostConfig
    if (!cfg.providers?.length) {
      console.error("cost plugin: no providers configured")
      return
    }
    await refreshFn(plugin)
    // Billing data lags by hours and AWS charges per Cost Explorer call, so hourly loses nothing.
    refreshTimer = setInterval(() => refreshFn(plugin), cfg.refreshInterval || DEFAULT_INTERVAL)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "cost",
    "cost",
    "Service spend per provider (daily, month to date, projection against a budget)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createCostPlugin
