// Run: bun test/workspace.check.ts
import assert from "node:assert/strict"
import { parseUsage, parseUsers, summarize } from "../plugins/monitoring/WorkspacePlugin.ts"

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
console.log("workspace ok")
