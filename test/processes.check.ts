// Run: bun test/processes.check.ts
import assert from "node:assert/strict"
import { parseStat, groupStats } from "../lib/processes.ts"

// A stat line with a space and a ')' in the comm: fields count from the last ')'.
const line = (pid: number, comm: string, ticks: number, start: number, rss: number) =>
    `${pid} (${comm}) S 1 1 1 0 -1 4194560 100 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 1000000 ${rss} 18446744073709551615`
const s = parseStat(7, line(7, "php-fpm: pool (www)", 250, 1000, 300))!
assert.deepEqual(s, { pid: 7, comm: "php-fpm: pool (www)", ticks: 250, rss: 300, start: 1000 })
assert.equal(parseStat(8, "garbage"), null)

const o = { hz: 100, page: 4096, uptime: 110 }
const a = parseStat(10, line(10, "mysqld", 1000, 1000, 500))!
const b = parseStat(11, line(11, "nginx", 50, 1000, 100))!
// First sample: over each one's life (100 s here), as ps has it.
const first = groupStats([a, b], null, { ...o, dt: 0 })
assert.equal(first.find((p) => p.name === "mysql")!.cpu, 10)
assert.equal(first.find((p) => p.name === "nginx")!.mem, 100 * 4096)
// Next sample 10 s on: mysql used 200 ticks (2 s of cpu) = 20% of a core;
// a new nginx worker (pid 12) used all of its 30 ticks in the interval.
const a2 = { ...a, ticks: 1200 }, c = parseStat(12, line(12, "nginx", 30, 10900, 100))!
const next = groupStats([a2, b, c], new Map([[10, 1000], [11, 50]]), { ...o, dt: 10 })
assert.equal(next.find((p) => p.name === "mysql")!.cpu, 20)
assert.equal(next.find((p) => p.name === "nginx")!.cpu, 3)
assert.equal(next.find((p) => p.name === "nginx")!.count, 2)
// A reused pid (fewer ticks than before) counts as new.
assert.equal(groupStats([{ ...a, ticks: 40 }], new Map([[10, 1000]]), { ...o, dt: 10 })[0]!.cpu, 4)
console.log("processes ok")
