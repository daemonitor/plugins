// Run: bun test/nagios.check.ts
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stateOf, parsePerfdata, parseOutput, runCheck } from "../plugins/monitoring/NagiosPlugin.ts"

// exit codes
assert.deepEqual([0, 1, 2, 3, 4, -1, null].map(stateOf), ["ok", "warning", "critical", "unknown", "unknown", "unknown", "unknown"])

// perfdata: units, thresholds, min/max, quoted labels, skipped junk
assert.deepEqual(parsePerfdata("/=2643MB;5948;5958;0;5968 'disk usage'=72%;80;90 load1=0.15;5.0;10.0;0 time=0.003s;;;0.000000 bad=U x"), [
  { label: "/", value: 2643, uom: "MB", warn: "5948", crit: "5958", min: 0, max: 5968 },
  { label: "disk usage", value: 72, uom: "%", warn: "80", crit: "90" },
  { label: "load1", value: 0.15, warn: "5.0", crit: "10.0", min: 0 },
  { label: "time", value: 0.003, uom: "s", min: 0 },
])
assert.deepEqual(parsePerfdata("'it''s'=1"), [{ label: "it's", value: 1 }])

// output: status line, long output, perfdata on both the first line and after long output
assert.deepEqual(parseOutput("DISK OK - free space: / 3326 MB (56%) | /=2643MB;5948;5958;0;5968\n"), {
  output: "DISK OK - free space: / 3326 MB (56%)",
  perfdata: [{ label: "/", value: 2643, uom: "MB", warn: "5948", crit: "5958", min: 0, max: 5968 }],
})
const multi = parseOutput("DISK OK | /=2643MB\n/var is fine\n/home is fine | /var=10MB\n/home=20MB\n")
assert.equal(multi.output, "DISK OK")
assert.equal(multi.longOutput, "/var is fine\n/home is fine")
assert.deepEqual(multi.perfdata.map((p) => p.label), ["/", "/var", "/home"])
assert.deepEqual(parseOutput("PING OK"), { output: "PING OK", perfdata: [] })

// running real commands: exit codes, timeouts, missing binaries, plugin dir
const dir = mkdtempSync(join(tmpdir(), "nagios-check-"))
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
script("check_warn", `echo "LOAD WARNING - load average: 6.1 | load1=6.1;5;10;0"; exit 1`)
script("check_crit", `echo "SSL CRITICAL - expires in 2 days"; exit 2`)
script("check_slow", `sleep 5; echo never`)
script("check_args", `echo "OK - got $1 $2"; exit 0`)

let r = await runCheck({ name: "load", command: ["check_warn"] }, { pluginDir: dir })
assert.equal(r.state, "warning")
assert.equal(r.exitCode, 1)
assert.equal(r.output, "LOAD WARNING - load average: 6.1")
assert.equal(r.perfdata[0].value, 6.1)
assert.equal(r.command, "check_warn")

r = await runCheck({ name: "ssl", command: [join(dir, "check_crit")] })
assert.equal(r.state, "critical")

// arguments are passed verbatim, never through a shell
r = await runCheck({ name: "args", command: ["check_args", "a b", "$(whoami)"] }, { pluginDir: dir })
assert.equal(r.output, "OK - got a b $(whoami)")

r = await runCheck({ name: "slow", command: ["check_slow"], timeout: 1 }, { pluginDir: dir })
assert.equal(r.state, "unknown")
assert.equal(r.timedOut, true)
assert.ok(r.durationMs < 3000)

r = await runCheck({ name: "missing", command: ["check_nope"] }, { pluginDir: dir })
assert.equal(r.state, "unknown")
assert.match(r.output, /Could not run check_nope: ENOENT/)

console.log("nagios: all checks passed")
