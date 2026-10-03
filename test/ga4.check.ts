// Run: bun test/ga4.check.ts
import assert from "node:assert/strict"
import { parseAccounts, parseProperty, parseRealtime, BATCH_BODY } from "../plugins/monitoring/Ga4Plugin.ts"

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
assert.ok(BATCH_BODY.requests.length <= 5 && BATCH_BODY.requests.every((r) => r.dateRanges.length <= 4))

console.log("ga4 checks passed")
