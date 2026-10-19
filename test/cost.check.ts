// Run: bun test/cost.check.ts
import assert from "node:assert/strict"
import { summarizeCost, fetchStart, daysInMonth, collectCost } from "../plugins/monitoring/CostPlugin.ts"
import { tally, sigv4, nextDay } from "../plugins/monitoring/CostProviders.ts"

assert.equal(daysInMonth("2026-02-10"), 28)
assert.equal(daysInMonth("2026-10-19"), 31)
assert.equal(fetchStart("2026-10-19"), "2026-09-20") // 29 days back beats the 1st
assert.equal(fetchStart("2026-10-31"), "2026-10-01")
assert.equal(nextDay("2026-12-31"), "2027-01-01")

// $10/day for the 18 complete days of October, $4 so far today, and one $90 spike yesterday.
const days = []
for (let d = 1; d <= 19; d++) days.push({ date: `2026-10-${String(d).padStart(2, "0")}`, amount: d === 19 ? 4 : d === 18 ? 90 : 10 })
days.push({ date: "2026-09-30", amount: 7 })
const s = summarizeCost({ currency: "USD", days }, "2026-10-19")
assert.equal(s.monthToDate, 17 * 10 + 90 + 4)
assert.equal(s.today, 4)
assert.equal(s.yesterday, 90)
assert.equal(s.avg7, 10) // the week BEFORE yesterday, so the spike is judged against a clean baseline
// Projection uses complete days only: (264 - 4) / 18 * 31.
assert.equal(s.projected, Math.round(((264 - 4) / 18) * 31 * 100) / 100)
assert.equal(s.daily.length, 30)
assert.equal(s.daily[0].date, "2026-09-20")
assert.equal(s.daily[10].amount, 7) // 09-30
assert.equal(s.daily[5].amount, 0) // gap-filled
// On the 1st nothing is complete yet: scale the partial day.
assert.equal(summarizeCost({ currency: "USD", days: [{ date: "2026-10-01", amount: 2 }] }, "2026-10-01").projected, 62)
// Month-to-date-only APIs: straight line.
assert.deepEqual(summarizeCost({ currency: "USD", monthToDate: 100 }, "2026-10-10"), { monthToDate: 100, projected: 310, daily: [] })

// tally keeps the breakdown to this month only.
const t = tally("2026-10")
t.add("2026-09-30", 5, "gpt")
t.add("2026-10-01", 3, "gpt")
t.add("2026-10-01", 1, "batch")
assert.deepEqual(t.days(), [{ date: "2026-09-30", amount: 5 }, { date: "2026-10-01", amount: 4 }])
assert.deepEqual(t.breakdown(), [{ name: "gpt", amount: 3 }, { name: "batch", amount: 1 }])

// SigV4: deterministic for a fixed clock, scoped to ce/us-east-1, and every header signed.
const h = sigv4({ host: "ce.us-east-1.amazonaws.com", region: "us-east-1", service: "ce", target: "T", body: "{}", accessKeyId: "AKID", secretAccessKey: "SECRET", now: new Date("2026-10-19T12:00:00Z") })
assert.equal(h["x-amz-date"], "20261019T120000Z")
assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261019\/us-east-1\/ce\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/)

// Unit conversion per API, through a stubbed fetch.
const realFetch = globalThis.fetch
const stub = (body: any) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as any }
stub({ data: [{ starting_at: "2026-10-18T00:00:00Z", results: [{ amount: "1234.5", model: "claude" }] }], has_more: false })
const a = await collectCost({ provider: "anthropic", adminKey: "x" }, "2026-10-19")
assert.equal(a.yesterday, 12.35) // cents string -> dollars
stub({ data: [{ start_time: Date.parse("2026-10-18T00:00:00Z") / 1000, results: [{ amount: { value: 3.5, currency: "usd" }, line_item: "gpt-5" }] }], has_more: false })
const o = await collectCost({ provider: "openai", adminKey: "x" }, "2026-10-19")
assert.equal(o.yesterday, 3.5)
assert.deepEqual(o.breakdown, [{ name: "gpt-5", amount: 3.5 }])
globalThis.fetch = (async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as any
await assert.rejects(collectCost({ provider: "openai", adminKey: "x" }), (e: any) => e.status === 401 && /bad key/.test(e.message))
await assert.rejects(collectCost({ provider: "openai" }), /needs adminKey/)
await assert.rejects(collectCost({ provider: "nope" }), /unknown cost provider/)
// gcp: token exchange, then one BigQuery query. Values are strings; the SQL already nets credits.
let sent: any
globalThis.fetch = (async (url: string, init: any) => {
  if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
  sent = JSON.parse(init.body)
  return new Response(JSON.stringify({ jobComplete: true, rows: [
    { f: [{ v: "2026-10-18" }, { v: "Compute Engine" }, { v: "EUR" }, { v: "12.5" }] },
    { f: [{ v: "2026-10-18" }, { v: "BigQuery" }, { v: "EUR" }, { v: "0.25" }] },
  ] }), { status: 200 })
}) as any
const gcfg = { provider: "gcp", clientId: "a", clientSecret: "b", refreshToken: "c", projectId: "p", table: "p.billing.gcp_billing_export_v1_0123" }
const g = await collectCost(gcfg, "2026-10-19")
assert.equal(g.currency, "EUR")
assert.equal(g.yesterday, 12.75)
assert.deepEqual(g.breakdown[0], { name: "Compute Engine", amount: 12.5 })
assert.ok(sent.query.includes("`p.billing.gcp_billing_export_v1_0123`") && sent.queryParameters[0].parameterValue.value === "2026-09-20")
// The table name is spliced into SQL, so anything but project.dataset.table is refused.
await assert.rejects(collectCost({ ...gcfg, table: "p.d.t` WHERE 1=1 --" }), /table must look like/)
globalThis.fetch = realFetch

console.log("cost checks passed")
