// Run: bun test/logwatch-rules.check.ts
import assert from "node:assert/strict"
import { analyze } from "../plugins/monitoring/LogWatchPlugin.ts"

const rule = {
  name: "signup-rejected",
  title: "Signup rejected",
  method: "POST",
  path: "/signup",
  bytes: [50, 60],
  referer: "/join/?(?:[?#]|$)",
}
// IPs are from the documentation ranges (RFC 5737, RFC 3849).
const cf = (ip: string, bytes: number, ref: string, path = "/signup") =>
  `www.example.com - 192.0.2.1 - ${ip} - - [01/Jan/2026:00:00:00 +0000] "POST ${path} HTTP/2.0" "200" ${bytes} "${ref}" "UA"`
const a = "2001:db8::1", b = "203.0.113.2"

const { findings, counts } = analyze([
  cf(a, 50, "https://www.example.com/join/"),
  cf(a, 50, "https://www.example.com/join/"),
  cf(b, 60, "https://www.example.com/join/?utm_source=mail"),
  cf("203.0.113.3", 70, "https://www.example.com/join/"), // size not listed
  cf("203.0.113.4", 50, "https://www.example.com/other/"), // referer doesn't match
  cf("203.0.113.5", 50, "https://www.example.com/join/", "/elsewhere"), // path doesn't match
], {}, 60, undefined, [rule])

assert.deepEqual(findings.map((f) => f.ip).sort(), [a, b].sort())
const f = findings.find((x) => x.ip === a)!
assert.equal(f.rule, "signup-rejected")
assert.equal(f.severity, "warning")
assert.equal(f.key, `rule:signup-rejected:${a}`)
assert.equal(f.detail, `${a}: Signup rejected (2×) on www.example.com`)
assert.equal(counts.ruleHits, 3)

// No rules configured: nothing beyond the built-in checks fires, whatever the line says.
assert.deepEqual(analyze([cf(a, 50, "https://www.example.com/join/")], {}, 60).findings, [])

// Standard combined format (no host, bare status) parses bytes and referer; a line without them doesn't match.
const std = analyze([
  `198.51.100.1 - - [01/Jan/2026:00:00:00 +0000] "POST /signup HTTP/1.1" 200 50 "https://www.example.com/join/" "UA"`,
  `198.51.100.2 - - [01/Jan/2026:00:00:00 +0000] "POST /signup HTTP/1.1" 200`,
], {}, 60, undefined, [rule])
assert.deepEqual(std.findings.map((x) => x.ip), ["198.51.100.1"])

// Built-in rules are unaffected by the wider request regex.
const old = analyze([
  `www.example.com - 192.0.2.1 - 198.51.100.3 - - [t] "POST /wp-json/batch/v1 HTTP/2.0" "207" 12 "-" "UA"`,
], {}, 60)
assert.equal(old.findings[0].rule, "wp-batch-207")

console.log("logwatch rules: ok")
