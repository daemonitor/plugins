// Run: bun test/netscan.check.ts
// Samples are real `ip -j neigh show <ip>` output from a Linux router.
import assert from "node:assert/strict"
import { neighState } from "../plugins/monitoring/NetScanPlugin.ts"

assert.deepEqual(neighState('[{"dst":"192.0.2.2","dev":"lan","lladdr":"02:00:00:00:00:01","state":["REACHABLE"]}]'), { state: "REACHABLE", mac: "02:00:00:00:00:01" })
assert.deepEqual(neighState('[{"dst":"192.0.2.2","dev":"lan","lladdr":"02:00:00:00:00:01","state":["DELAY"]}]'), { state: "DELAY", mac: "02:00:00:00:00:01" })
assert.deepEqual(neighState('[{"dst":"192.0.2.9","dev":"lan","state":["FAILED"]}]'), { state: "FAILED" })
assert.equal(neighState("[]"), null) // never seen
assert.equal(neighState("not json"), null)
console.log("netscan: all checks passed")
