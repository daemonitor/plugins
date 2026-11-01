// Run: bun test/appactivity.check.ts
import assert from "node:assert/strict"
import { maskEmail, sourceUid, summariseAudit, summariseUsers } from "../plugins/monitoring/AppActivityPlugin.ts"
import { registrationCounts } from "../plugins/monitoring/WordpressPlugin.ts"

const now = Date.parse("2026-11-01T12:00:00Z")
const ago = (days: number) => new Date(now - days * 86_400_000).toISOString()

assert.equal(maskEmail("person@example.com"), "p***@example.com")
for (const bad of [null, undefined, "", "@example.com", "service_role"]) assert.equal(maskEmail(bad), "unknown")

// Each window includes the smaller ones, and no address survives.
const audit = summariseAudit(
  12,
  [
    { at: ago(0.5), action: "user_signedup", who: "a@x.io", provider: "google" },
    { at: ago(3), action: "login", who: "b@x.io" },
    { at: ago(20), action: "login", who: "c@x.io" },
  ],
  now,
)
assert.deepEqual(audit.signups, { d1: 1, d7: 1, d30: 1 })
assert.deepEqual(audit.logins, { d1: 0, d7: 1, d30: 2 })
assert.equal(audit.loginsArePeople, false)
assert.equal(audit.recent[0].who, "a***@x.io")
assert.equal(audit.recent[0].provider, "google")
assert.ok(!JSON.stringify(audit).includes("a@x.io"))

// Cloud: older users count as users only, and a never-signed-in user isn't a login.
const cloud = summariseUsers(
  [
    { email: "new@x.io", created_at: ago(2), last_sign_in_at: ago(2), app_metadata: { provider: "email" } },
    { email: "old@x.io", created_at: ago(400), last_sign_in_at: ago(10) },
    { email: "gone@x.io", created_at: ago(400), last_sign_in_at: ago(90) },
    { email: "invited@x.io", created_at: ago(40), last_sign_in_at: null },
  ],
  now,
)
assert.equal(cloud.users, 4)
assert.deepEqual(cloud.signups, { d1: 0, d7: 1, d30: 1 })
assert.deepEqual(cloud.logins, { d1: 0, d7: 1, d30: 2 })
assert.equal(cloud.loginsArePeople, true)
assert.ok(!JSON.stringify(cloud).includes("new@x.io"))

assert.equal(sourceUid({ name: "Summarized.bio" }), "activity-summarized-bio")
assert.equal(sourceUid({ name: "x", uniqueId: "y" }), "y")

assert.deepEqual(
  registrationCounts(["2026-11-01 06:00:00", "2026-10-20 00:00:00", "2019-01-01 00:00:00", "not a date"], now),
  { users: 4, signups: { d1: 1, d7: 1, d30: 2 } },
)

console.log("appactivity ok")
