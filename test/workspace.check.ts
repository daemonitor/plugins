// Run: bun test/workspace.check.ts
import assert from "node:assert/strict"
import { parseUsage, parseUsers, summarize, countSeats, poolBytes } from "../plugins/monitoring/WorkspacePlugin.ts"

const p = (name: string, intValue: string) => ({ name, intValue })
// A day Google hasn't published yet carries warnings and no parameters.
assert.equal(parseUsage({ warnings: [{ code: "PARTIAL_DATA_AVAILABLE" }], usageReports: [] }), null)

const u = parseUsage({ usageReports: [{ parameters: [
  p("accounts:used_quota_in_mb", "3533701"), p("accounts:total_quota_in_mb", "7853834"),
  p("accounts:drive_used_quota_in_mb", "1500000"), p("accounts:gmail_used_quota_in_mb", "2000000"),
  { name: "accounts:authorized_apps", msgValue: [] }, p("gmail:num_emails_sent", "9"),
] }] })!
assert.equal(u.used_quota_in_mb, 3533701)
assert.equal(u.num_emails_sent, undefined)
const s = summarize(u, "2026-11-03")
assert.equal(s.usedPct, 45)
assert.equal(s.breakdown[2].bytes, 0)
// Business plans without a pooled cap report a negative total.
assert.equal(summarize({ used_quota_in_mb: 5, total_quota_in_mb: -1 }, "x").usedPct, null)
const users = parseUsers({ usageReports: [
  { entity: { userEmail: "a@x.com" }, parameters: [p("accounts:used_quota_in_mb", "2048"), p("accounts:gmail_used_quota_in_mb", "1024")] },
  { entity: { type: "USER" }, parameters: [] },
] })
assert.equal(users.length, 1)
assert.equal(users[0].bytes, 2 * 1024 ** 3)
assert.equal(users[0].gmail, 1024 ** 3)
assert.equal(users[0].drive, 0)
// The pool from seats: AN after 2026-11-05 was 60 Starter, 6 Standard, 1 Plus = 18.76 TiB.
const lic = (skuId: string, skuName: string, n: number) => Array.from({ length: n }, () => ({ skuId, skuName }))
const seats = countSeats([...lic("1010020027", "Google Workspace Business Starter", 60), ...lic("1010020028", "Google Workspace Business Standard", 6), ...lic("1010020025", "Google Workspace Business Plus", 1)])
assert.equal(seats[0].name, "Business Starter")
assert.equal((poolBytes(seats)! / 1024 ** 4).toFixed(2), "18.76")
// Before the changes: 85 Starter was the 2.49 TB Drive showed.
assert.equal((poolBytes(countSeats(lic("1010020027", "x", 85)))! / 1024 ** 4).toFixed(2), "2.49")
// An unknown SKU means no licence pool (the report's stands in), unless configured.
assert.equal(poolBytes(countSeats(lic("999", "Mystery", 1))), null)
assert.equal(poolBytes(countSeats(lic("999", "Mystery", 1)), { "999": 100 }), 100 * 1024 ** 3)
console.log("workspace ok")
