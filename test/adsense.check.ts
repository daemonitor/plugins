// Run: bun test/adsense.check.ts
import assert from "node:assert/strict"
import { shiftDate, todayIn, reportStart, reportUrl, parseReport, summarize, parseSiteReport, summarizeSites } from "../plugins/monitoring/AdsensePlugin.ts"

// Date shifts cross month and year boundaries.
assert.equal(shiftDate("2026-03-01", -1), "2026-02-28")
assert.equal(shiftDate("2026-01-01", -1), "2025-12-31")

// "Today" is the account's day, not the host's: 03:00 UTC is still the 1st in New York.
assert.equal(todayIn("America/New_York", new Date("2026-10-02T03:00:00Z")), "2026-10-01")
assert.equal(todayIn(undefined, new Date("2026-10-02T03:00:00Z")), "2026-10-02")

// One report has to cover both the month and the 30-day sparkline.
assert.equal(reportStart("2026-10-02"), "2026-09-03") // early in the month: 29 days back wins
assert.equal(reportStart("2026-10-31"), "2026-10-01") // late in the month: the 1st wins

const url = reportUrl("accounts/pub-1", "2026-09-03", "2026-10-02")
assert.ok(url.startsWith("https://adsense.googleapis.com/v2/accounts/pub-1/reports:generate?"))
assert.ok(url.includes("startDate.month=9") && url.includes("startDate.day=3") && url.includes("endDate.day=2"))
assert.ok(url.includes("metrics=ESTIMATED_EARNINGS") && url.includes("metrics=PAGE_VIEWS") && url.includes("metrics=CLICKS"))

// Columns are read by header name, so a reordered response still parses.
const report = {
  headers: [
    { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
    { name: "DATE", type: "DIMENSION" },
    { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "EUR" },
  ],
  rows: [
    { cells: [{ value: "1000" }, { value: "2026-09-30" }, { value: "10.00" }] },
    { cells: [{ value: "500" }, { value: "2026-10-01" }, { value: "4.11" }] },
    { cells: [{ value: "250" }, { value: "2026-10-02" }, { value: "1.50" }] },
  ],
}
const parsed = parseReport(report)
assert.equal(parsed.currency, "EUR")
assert.deepEqual(parsed.days[1], { date: "2026-10-01", earnings: 4.11, pageViews: 500, clicks: 0 }) // no CLICKS column in this report
// No rows = no traffic, not an error. No earnings column = a real error.
assert.deepEqual(parseReport({ headers: report.headers }).days, [])
assert.throws(() => parseReport({ headers: [{ name: "DATE" }] }))

const s = summarize(parsed.days, "2026-10-02")
assert.equal(s.today, 1.5)
assert.equal(s.yesterday, 4.11)
assert.equal(s.last7, 15.61) // 10 + 4.11 + 1.5, the other four days absent
assert.equal(s.monthToDate, 5.61) // September's 10.00 is excluded
assert.equal(s.pageViews7, 1750)
assert.equal(s.clicks7, 0)
assert.equal(s.rpm, 8.92) // 15.61 / 1750 * 1000
assert.equal(s.daily.length, 30)
assert.equal(s.daily[29].date, "2026-10-02")
assert.equal(s.daily[0].date, "2026-09-03")
assert.equal(s.daily[26].earnings, 0) // 2026-09-29 had no row

// An empty account reads as zeroes, with no divide-by-zero in RPM.
const empty = summarize([], "2026-10-02")
assert.deepEqual([empty.today, empty.last7, empty.monthToDate, empty.rpm], [0, 0, 0, 0])

// Per-site: one report with DATE x DOMAIN_NAME, split by domain.
assert.ok(reportUrl("accounts/pub-1", "2026-09-03", "2026-10-02", true).includes("dimensions=DATE&dimensions=DOMAIN_NAME"))
assert.ok(!url.includes("DOMAIN_NAME"))
const siteReport = {
  headers: [
    { name: "DATE", type: "DIMENSION" },
    { name: "DOMAIN_NAME", type: "DIMENSION" },
    { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "USD" },
    { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
    { name: "CLICKS", type: "METRIC_TALLY" },
  ],
  rows: [
    { cells: [{ value: "2026-10-01" }, { value: "small.example" }, { value: "0.50" }, { value: "100" }, { value: "1" }] },
    { cells: [{ value: "2026-10-01" }, { value: "www.big.example" }, { value: "30.00" }, { value: "9000" }, { value: "40" }] },
    { cells: [{ value: "2026-10-02" }, { value: "www.big.example" }, { value: "1.25" }, { value: "400" }, { value: "3" }] },
    { cells: [{ value: "2026-10-02" }, { value: "admin.big.example" }, { value: "0.00" }, { value: "60" }, { value: "0" }] },
    { cells: [{ value: "2026-10-02" }, { value: "big.example" }, { value: "0.25" }, { value: "50" }, { value: "2" }] },
  ],
}
const sites = summarizeSites(parseSiteReport(siteReport), "2026-10-02")
// Biggest earner first; the zero-earning admin host is dropped; www and bare host merge.
assert.deepEqual(sites.map((x) => x.domain), ["big.example", "small.example"])
assert.deepEqual([sites[0].today, sites[0].yesterday, sites[0].last7, sites[0].pageViews7], [1.5, 30, 31.5, 9450])
assert.equal(sites[0].clicks7, 45) // 40 + 3 + 2, www and bare host merged
assert.equal(sites[0].daily.length, 30)
assert.deepEqual(sites[0].daily.slice(-2), [30, 1.5]) // earnings only, oldest first
assert.equal(sites[1].today, 0)
assert.deepEqual(summarizeSites(parseSiteReport({ headers: report.headers, rows: report.rows }), "2026-10-02"), []) // no DOMAIN_NAME column

console.log("adsense checks passed")
