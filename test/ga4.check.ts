// Run: bun test/ga4.check.ts
import assert from "node:assert/strict"
import { parseAccounts, parseDomains, parsePages, parseProperty, parseRealtime, batchBody, pagesRequest } from "../plugins/monitoring/Ga4Plugin.ts"

// Account tree: ids lose their prefixes; sub-properties and roll-ups are skipped.
const accounts = parseAccounts([
  {
    account: "accounts/842890",
    displayName: "AN MEDIA GROUP",
    propertySummaries: [
      { property: "properties/273200641", displayName: "AN - GA4", propertyType: "PROPERTY_TYPE_ORDINARY" },
      { property: "properties/1", displayName: "Roll-up", propertyType: "PROPERTY_TYPE_ROLLUP" },
      { property: "properties/368492268", displayName: "AN INTERIOR - GA4" },
    ],
  },
  { account: "accounts/117318363", displayName: "HERETIC NYC" },
])
assert.deepEqual(accounts[0].properties.map((p) => p.id), ["273200641", "368492268"])
assert.equal(accounts[0].id, "842890")
assert.deepEqual(accounts[1].properties, [])

// Two reports: named ranges, then by date. Dates come back unordered and gappy.
const batch = {
  reports: [
    {
      metadata: { timeZone: "America/New_York" },
      rows: [
        { dimensionValues: [{ value: "last7" }], metricValues: [{ value: "900" }, { value: "1200" }, { value: "3000" }] },
        { dimensionValues: [{ value: "today" }], metricValues: [{ value: "100" }, { value: "120" }, { value: "300" }] },
      ],
    },
    {
      metadata: { timeZone: "America/New_York" },
      rows: [
        { dimensionValues: [{ value: "20261002" }], metricValues: [{ value: "100" }, { value: "120" }, { value: "300" }] },
        { dimensionValues: [{ value: "20260930" }], metricValues: [{ value: "80" }, { value: "90" }, { value: "200" }] },
      ],
    },
  ],
}
// 03:00 UTC on the 3rd is still the 2nd in New York: the property's day is used.
const p = parseProperty(batch, new Date("2026-10-03T03:00:00Z"))
assert.equal(p.asOf, "2026-10-02")
assert.deepEqual(p.today, { users: 100, sessions: 120, views: 300 })
assert.deepEqual(p.yesterday, { users: 0, sessions: 0, views: 0 }) // no row = no traffic
assert.equal(p.last7.users, 900) // GA's own 7-day count, not a sum of days
assert.equal(p.daily.users.length, 30)
assert.equal(p.daily.start, "2026-09-03")
assert.deepEqual(p.daily.users.slice(-3), [80, 0, 100]) // Sep 30, (Oct 1 missing), Oct 2

// Realtime: no rows means nobody is on the site.
assert.equal(parseRealtime({ rows: [{ metricValues: [{ value: "37" }] }] }), 37)
assert.equal(parseRealtime({}), 0)

// GA allows at most 4 date ranges per request and 5 requests per batch.
const BATCH_BODY = batchBody()
assert.ok(BATCH_BODY.requests.length <= 5 && BATCH_BODY.requests.every((r) => r.dateRanges.length <= 4))

// A property's sites are its web streams' hosts, whatever form the URI takes.
assert.deepEqual(parseDomains({ dataStreams: [
  { webStreamData: { defaultUri: "https://www.archpaper.com" } },
  { webStreamData: { defaultUri: "buzz.archpaper.com" } },
  { webStreamData: { defaultUri: "https://archpaper.com/" } },
  { type: "IOS_APP_DATA_STREAM" },
] }), ["archpaper.com", "buzz.archpaper.com"])
assert.deepEqual(parseDomains(null), [])

// Top pages: /a and /a/ add up, a shared site name comes off the titles, www doesn't split a host.
const row = (host: string, path: string, title: string, views: number) => ({ dimensionValues: [{ value: host }, { value: path }, { value: title }], metricValues: [{ value: String(views) }] })
const pages = parsePages({ rows: [
  row("www.big.example", "/2026/10/one", "Story one | The Paper", 500),
  row("www.big.example", "/2026/10/two/", "Story two - with a dash | The Paper", 300),
  row("www.big.example", "/2026/10/two", "Story two - with a dash | The Paper", 200),
  row("jobs.big.example", "/job/1", "A job | The Paper", 100),
] })
assert.deepEqual(pages, [
  { host: "big.example", path: "/2026/10/one", title: "Story one", views: 500 },
  { host: "big.example", path: "/2026/10/two", title: "Story two - with a dash", views: 500 },
  { host: "jobs.big.example", path: "/job/1", title: "A job", views: 100 },
])
// A title's own ending stays when the others don't share it.
assert.equal(parsePages({ rows: [row("a.example", "/x", "Bears - a stadium", 3), row("a.example", "/y", "Other story", 2), row("a.example", "/z", "Third", 1)] })[0]!.title, "Bears - a stadium")
// At most ten per host, so one big site can't crowd out another in the same property.
assert.equal(parsePages({ rows: Array.from({ length: 30 }, (_, i) => row("a.example", `/p${i}`, `T${i}`, 100 - i)) }).length, 10)

// The filter: a pulled post goes in both forms, on top of the home page and archives.
const req = pagesRequest("30daysAgo", ["/2023/10/pulled/"])
const exprs = req.dimensionFilter.notExpression.orGroup.expressions as any[]
assert.deepEqual(exprs[0].filter.inListFilter.values, ["/2023/10/pulled", "/2023/10/pulled/"])
const excluded = exprs.slice(1).map((e) => new RegExp(e.filter.stringFilter.value))
for (const path of ["/", "/news", "/news/", "/calendar/feed/", "/category/x", "/tag/y", "/author/z/"]) assert.ok(excluded.some((re) => re.test(path)), path)
for (const path of ["/2026/10/som-bears-stadium-chicago", "/2026/10/x/"]) assert.ok(!excluded.some((re) => re.test(path)), path)
assert.equal(pagesRequest("1daysAgo").dimensionFilter.notExpression.orGroup.expressions.length, 2)

console.log("ga4 checks passed")
