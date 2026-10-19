import { createHash, createHmac } from "node:crypto"
import { googleAccessToken } from "./AdsensePlugin.js"
import type { CostFetch, CostProviderConfig, CostDay } from "./CostPlugin.js"

// One fetcher per billing API. Each takes the provider's config block and a UTC
// date range (start..end, both inclusive, YYYY-MM-DD) and returns daily amounts
// in whole currency units, or a month-to-date figure where the API has no daily
// data. Units differ wildly between APIs (cents, micros, strings) and are
// converted HERE, so nothing downstream has to know which API a number came from.
//
// Specs read 2026-10-19. Cloudflare's billable-usage and PostHog's spend
// endpoints are marked alpha/beta by their vendors and may change shape.

export type CostFetcher = (cfg: CostProviderConfig, range: { start: string; end: string }, timeout: number) => Promise<CostFetch>

/** Thrown for non-2xx; `status` lets the plugin tell a dead key (401/403) from an outage. */
export class HttpError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

async function call(url: string, init: RequestInit, timeout: number): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let msg = text.slice(0, 160)
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message || j?.errors?.[0]?.message || j?.message || j?.detail || j?.msg || (typeof j?.error === "string" ? j.error : msg)
    } catch { /* not JSON */ }
    throw new HttpError(`HTTP ${res.status}${msg ? `: ${msg}` : ""}`, res.status)
  }
  return res
}
const json = async (url: string, init: RequestInit, timeout: number) => (await call(url, init, timeout)).json() as Promise<any>

const need = (cfg: CostProviderConfig, ...keys: string[]) => {
  const missing = keys.filter((k) => !cfg[k])
  if (missing.length) throw new Error(`${cfg.provider} needs ${missing.join(", ")}`)
}

export const nextDay = (date: string) => {
  const t = new Date(`${date}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}
const unixDay = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
const isoDay = (unixSec: number) => new Date(unixSec * 1000).toISOString().slice(0, 10)

/** Accumulates per-day amounts and per-item month-to-date amounts. */
export function tally(month: string) {
  const days = new Map<string, number>()
  const items = new Map<string, number>()
  return {
    add(date: string, amount: number, item?: string) {
      if (!date || !Number.isFinite(amount)) return
      days.set(date, (days.get(date) || 0) + amount)
      if (item && date.startsWith(month)) items.set(item, (items.get(item) || 0) + amount)
    },
    days: (): CostDay[] => [...days].map(([date, amount]) => ({ date, amount })),
    breakdown: () => [...items].map(([name, amount]) => ({ name, amount })),
  }
}

// OpenAI: Costs API, admin key. Amounts are numbers in dollars. End is exclusive.
const openai: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "adminKey")
  const t = tally(end.slice(0, 7))
  let page: string | undefined
  do {
    const q = new URLSearchParams({ start_time: String(unixDay(start)), end_time: String(unixDay(nextDay(end))), bucket_width: "1d", limit: "31" })
    q.append("group_by[]", "line_item")
    if (page) q.set("page", page)
    const body = await json(`https://api.openai.com/v1/organization/costs?${q}`, { headers: { Authorization: `Bearer ${cfg.adminKey}` } }, timeout)
    for (const b of body.data || []) {
      for (const r of b.results || []) t.add(isoDay(b.start_time), Number(r.amount?.value) || 0, r.line_item || undefined)
    }
    page = body.has_more ? body.next_page : undefined
  } while (page)
  return { currency: "USD", days: t.days(), breakdown: t.breakdown() }
}

// Anthropic: Admin API cost report. Amount is a decimal STRING in CENTS.
const anthropic: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "adminKey")
  const t = tally(end.slice(0, 7))
  let page: string | undefined
  do {
    const q = new URLSearchParams({ starting_at: `${start}T00:00:00Z`, ending_at: `${nextDay(end)}T00:00:00Z`, bucket_width: "1d", limit: "31" })
    q.append("group_by[]", "description")
    if (page) q.set("page", page)
    const body = await json(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
      headers: { "x-api-key": cfg.adminKey, "anthropic-version": "2023-06-01" },
    }, timeout)
    for (const b of body.data || []) {
      const date = String(b.starting_at || "").slice(0, 10)
      for (const r of b.results || []) t.add(date, (parseFloat(r.amount) || 0) / 100, r.model || r.description || r.cost_type || undefined)
    }
    page = body.has_more ? body.next_page : undefined
  } while (page)
  return { currency: "USD", days: t.days(), breakdown: t.breakdown() }
}

/** AWS SigV4 for a JSON POST. Small enough not to pull in the SDK for one call. */
export function sigv4(opts: {
  host: string; region: string; service: string; target: string; body: string
  accessKeyId: string; secretAccessKey: string; sessionToken?: string; now?: Date
}) {
  const now = opts.now || new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const day = amzDate.slice(0, 8)
  const sha = (s: string) => createHash("sha256").update(s).digest("hex")
  const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest()
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: opts.host,
    "x-amz-date": amzDate,
    "x-amz-target": opts.target,
    ...(opts.sessionToken ? { "x-amz-security-token": opts.sessionToken } : {}),
  }
  const names = Object.keys(headers).sort()
  const canonical = ["POST", "/", "", ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), sha(opts.body)].join("\n")
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n")
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), opts.region), opts.service), "aws4_request")
  const sig = createHmac("sha256", key).update(toSign).digest("hex")
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`
  return headers
}

// AWS: Cost Explorer GetCostAndUsage. $0.01 per request, so this is one call
// (plus pages). Amounts are dollar strings. End is exclusive.
const aws: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "accessKeyId", "secretAccessKey")
  const t = tally(end.slice(0, 7))
  let token: string | undefined
  let currency = "USD"
  do {
    const body = JSON.stringify({
      TimePeriod: { Start: start, End: nextDay(end) },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      ...(token ? { NextPageToken: token } : {}),
    })
    const host = "ce.us-east-1.amazonaws.com"
    const headers = sigv4({
      host, region: "us-east-1", service: "ce", target: "AWSInsightsIndexService.GetCostAndUsage", body,
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: cfg.sessionToken,
    })
    const res = await json(`https://${host}/`, { method: "POST", headers, body }, timeout)
    for (const r of res.ResultsByTime || []) {
      const date = r.TimePeriod?.Start
      for (const g of r.Groups || []) {
        const m = g.Metrics?.UnblendedCost
        if (m?.Unit) currency = m.Unit
        t.add(date, parseFloat(m?.Amount) || 0, g.Keys?.[0])
      }
    }
    token = res.NextPageToken
  } while (token)
  return { currency, days: t.days(), breakdown: t.breakdown() }
}

// Vercel: FOCUS billing charges, streamed as JSONL, many lines per day (one per SKU).
const vercel: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "token", "teamId")
  const t = tally(end.slice(0, 7))
  const q = new URLSearchParams({ teamId: cfg.teamId, from: `${start}T00:00:00Z`, to: `${nextDay(end)}T00:00:00Z` })
  const text = await (await call(`https://api.vercel.com/v1/billing/charges?${q}`, { headers: { Authorization: `Bearer ${cfg.token}` } }, timeout)).text()
  let currency = "USD"
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const c = JSON.parse(line)
    if (c.BillingCurrency) currency = c.BillingCurrency
    t.add(String(c.ChargePeriodStart || "").slice(0, 10), Number(c.BilledCost) || 0, c.ServiceName || undefined)
  }
  return { currency, days: t.days(), breakdown: t.breakdown() }
}

// Fastly: month-to-date invoice only. No daily data exists in the API.
const fastly: CostFetcher = async (cfg, _range, timeout) => {
  need(cfg, "token")
  const inv = await json("https://api.fastly.com/billing/v3/invoices/month-to-date", { headers: { "Fastly-Key": cfg.token, Accept: "application/json" } }, timeout)
  const items: any[] = inv.transaction_line_items || []
  return {
    currency: inv.currency_code || "USD",
    monthToDate: Number(inv.monthly_transaction_amount) || items.reduce((s, i) => s + (Number(i.amount) || 0), 0),
    breakdown: items.map((i) => ({ name: i.product_name || i.description || "item", amount: Number(i.amount) || 0 })),
  }
}

// Cloudflare: billable usage (alpha, PayGo usage only, not plan fees). Called
// with no range: it then returns the current billing period, which sidesteps
// the rule that a range must include the subscription's billing-anchor day.
const cloudflare: CostFetcher = async (cfg, { end }, timeout) => {
  need(cfg, "token", "accountId")
  const t = tally(end.slice(0, 7))
  const body = await json(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/billable-usage`, { headers: { Authorization: `Bearer ${cfg.token}` } }, timeout)
  let currency = "USD"
  for (const r of body.result || []) {
    if (r.BillingCurrency) currency = r.BillingCurrency
    t.add(String(r.ChargePeriodStart || "").slice(0, 10), Number(r.BilledCost) || 0, r.ServiceName || r.ChargeDescription || undefined)
  }
  return { currency, days: t.days(), breakdown: t.breakdown() }
}

// PostHog: daily spend series, personal API key with billing:read. End is INCLUSIVE.
const posthog: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "apiKey")
  const host = (cfg.host || "https://us.posthog.com").replace(/\/$/, "")
  const t = tally(end.slice(0, 7))
  const q = new URLSearchParams({ start_date: start, end_date: end, interval: "day", breakdowns: JSON.stringify(["type"]) })
  let url: string | null = `${host}/api/billing/spend/?${q}`
  while (url) {
    const body: any = await json(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } }, timeout)
    for (const s of body.results || []) {
      const dates: string[] = s.dates || []
      dates.forEach((d, i) => t.add(d, Number(s.data?.[i]) || 0, s.breakdown_value || s.label || undefined))
    }
    url = body.next || null
  }
  return { currency: "USD", days: t.days(), breakdown: t.breakdown() }
}

// Google Ads: GAQL over searchStream. cost_micros is an int64 string. Dates are
// the ACCOUNT's time zone, which this treats as UTC days (off by a few hours at most).
const googleAds: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "clientId", "clientSecret", "refreshToken", "developerToken", "customerId")
  const t = tally(end.slice(0, 7))
  const customer = String(cfg.customerId).replace(/-/g, "")
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await googleAccessToken({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken }, timeout)}`,
    "developer-token": cfg.developerToken,
    "Content-Type": "application/json",
    ...(cfg.loginCustomerId ? { "login-customer-id": String(cfg.loginCustomerId).replace(/-/g, "") } : {}),
  }
  const query = `SELECT segments.date, customer.currency_code, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}'`
  const batches = await json(`https://googleads.googleapis.com/${cfg.apiVersion || "v26"}/customers/${customer}/googleAds:searchStream`, {
    method: "POST", headers, body: JSON.stringify({ query }),
  }, timeout)
  let currency = "USD"
  for (const b of Array.isArray(batches) ? batches : [batches]) {
    for (const r of b.results || []) {
      if (r.customer?.currencyCode) currency = r.customer.currencyCode
      t.add(r.segments?.date, (Number(r.metrics?.costMicros) || 0) / 1e6, r.campaign?.name)
    }
  }
  return { currency, days: t.days(), breakdown: t.breakdown() }
}

// Google Cloud: there is no spend REST API. The supported source is the Cloud
// Billing export to BigQuery (standard usage cost), queried here with
// jobs.query. Net cost = cost + credits (credits are negative). The export
// lands hours late, so today and yesterday fill in after the fact.
// ponytail: OAuth refresh token (scope bigquery.readonly), same as the other
// Google sources. Add service-account JWT auth if a human token is unwelcome.
const gcp: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "clientId", "clientSecret", "refreshToken", "projectId", "table")
  // `project.dataset.gcp_billing_export_v1_XXXXXX`. Validated because it is
  // spliced into SQL; BigQuery cannot bind a table name as a parameter.
  if (!/^[\w-]+\.[\w]+\.[\w]+$/.test(cfg.table)) throw new Error("gcp table must look like project.dataset.gcp_billing_export_v1_XXXXXX")
  const t = tally(end.slice(0, 7))
  const query = `SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, service.description AS item, ANY_VALUE(currency) AS currency,
      SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS amount
    FROM \`${cfg.table}\`
    WHERE DATE(_PARTITIONTIME) >= DATE_SUB(@start, INTERVAL 1 DAY) AND DATE(usage_start_time) BETWEEN @start AND @end
    GROUP BY day, item`
  const body = await json(`https://bigquery.googleapis.com/bigquery/v2/projects/${cfg.projectId}/queries`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await googleAccessToken({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken }, timeout)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query, useLegacySql: false, timeoutMs: timeout, parameterMode: "NAMED",
      queryParameters: [
        { name: "start", parameterType: { type: "DATE" }, parameterValue: { value: start } },
        { name: "end", parameterType: { type: "DATE" }, parameterValue: { value: end } },
      ],
    }),
  }, timeout + 5000)
  if (body.jobComplete === false) throw new Error("BigQuery query did not finish in time")
  let currency = "USD"
  // Rows come back as { f: [{ v }] } in SELECT order, every value a string.
  for (const r of body.rows || []) {
    const [day, item, cur, amount] = (r.f || []).map((c: any) => c?.v)
    if (cur) currency = cur
    t.add(day, Number(amount) || 0, item || undefined)
  }
  return { currency, days: t.days(), breakdown: t.breakdown() }
}

// Meta Ads: Marketing API insights, one row per day. spend is a numeric string.
const metaAds: CostFetcher = async (cfg, { start, end }, timeout) => {
  need(cfg, "accessToken", "adAccountId")
  const t = tally(end.slice(0, 7))
  const acct = String(cfg.adAccountId).replace(/^act_/, "")
  const v = cfg.apiVersion || "v26.0"
  const auth = { headers: { Authorization: `Bearer ${cfg.accessToken}` } }
  const { currency } = await json(`https://graph.facebook.com/${v}/act_${acct}?fields=currency`, auth, timeout)
  const q = new URLSearchParams({
    fields: "spend,campaign_name", level: "campaign", time_increment: "1",
    time_range: JSON.stringify({ since: start, until: end }), limit: "500",
  })
  let url: string | null = `https://graph.facebook.com/${v}/act_${acct}/insights?${q}`
  while (url) {
    const body: any = await json(url, auth, timeout)
    for (const r of body.data || []) t.add(r.date_start, parseFloat(r.spend) || 0, r.campaign_name)
    url = body.paging?.next || null
  }
  return { currency: currency || "USD", days: t.days(), breakdown: t.breakdown() }
}

export const PROVIDERS: Record<string, CostFetcher> = {
  openai, anthropic, aws, vercel, fastly, cloudflare, posthog, gcp, "google-ads": googleAds, "meta-ads": metaAds,
}
