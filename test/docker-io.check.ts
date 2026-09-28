// Run: bun test/docker-io.check.ts
import assert from "node:assert/strict"
import { parseIoStat, parseNetDev, cgroupV2Path, ioRate } from "../plugins/monitoring/DockerPlugin.ts"

// io.stat: summed across devices; a cgroup that never did IO has an empty file.
assert.deepEqual(
  parseIoStat("179:0 rbytes=62111744 wbytes=17800000123 rios=1 wios=2 dbytes=0 dios=0\n8:0 rbytes=100 wbytes=5 rios=1 wios=1 dbytes=0 dios=0\n"),
  { a: 62111844, b: 17800000128 },
)
assert.deepEqual(parseIoStat(""), { a: 0, b: 0 })
assert.equal(parseIoStat("garbage"), null)

// net/dev: loopback skipped, every other interface summed.
const dev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
  eth0: 834000000 900    0    0    0     0          0         0 509000000  800    0    0    0     0       0          0
  eth1:      12       1    0    0    0     0          0         0        8     1    0    0    0     0       0          0
`
assert.deepEqual(parseNetDev(dev), { a: 834000012, b: 509000008 })
assert.equal(parseNetDev("Inter-| Receive\n face |bytes\n"), null)

// cgroup path: v2 line only.
assert.equal(cgroupV2Path("0::/system.slice/docker-abc.scope\n"), "/system.slice/docker-abc.scope")
assert.equal(cgroupV2Path("12:blkio:/docker/abc\n1:name=systemd:/docker/abc\n"), null)

// The bug this replaces: 17.8GB -> 17.8GB over 30s read as 0. Exact counters
// see the 3MB written.
assert.equal(ioRate(17_800_003_000, 17_800_000_000, 30), 100)
// counter reset (container restarted) and no previous reading -> no rate
assert.equal(ioRate(10, 5_000, 30), undefined)
assert.equal(ioRate(10, undefined, 30), undefined)

console.log("docker-io checks passed")
