// Aggregate named service processes (nginx, php-fpm, db, …). A Linux host's
// come from /proc (sampleProcesses), with CPU measured over the time since
// the last sample, so a graph of it moves. Everywhere else, and a container's
// (LxcPlugin via `lxc exec … ps`), from `ps` output, whose %cpu is the average
// over each process's lifetime: for a daemon up for months it never moves.
import { execSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"

export interface ProcInfo {
    name: string
    count: number
    cpu: number
    mem: number
}

// The command whose output parseProcesses() expects (headerless: comm rss pcpu).
export const PS_CMD = "ps -eo comm=,rss=,pcpu="

const WATCH: { key: string; test: (comm: string) => boolean }[] = [
    { key: "nginx", test: (c) => c.startsWith("nginx") },
    { key: "php-fpm", test: (c) => /^php-?fpm/i.test(c) },
    { key: "mysql", test: (c) => c.startsWith("mysqld") || c.startsWith("mariadbd") },
    { key: "postgres", test: (c) => c.startsWith("postgres") },
    { key: "redis", test: (c) => c.startsWith("redis-server") || c.startsWith("redis") },
    { key: "node", test: (c) => c.startsWith("node") },
]

/** One process as /proc/<pid>/stat has it: its comm, cpu ticks (user and system), rss in pages, and start in ticks after boot. */
export interface ProcStat { pid: number; comm: string; ticks: number; rss: number; start: number }

/**
 * Parse /proc/<pid>/stat. Its comm is in parentheses and may hold spaces or
 * a ')' of its own, so the fields are counted from after the last ')': the
 * first one there is field 3 (state), so utime (14) is index 11.
 */
export function parseStat(pid: number, text: string): ProcStat | null {
    const open = text.indexOf("("), close = text.lastIndexOf(")")
    if (open < 0 || close < open) return null
    const f = text.slice(close + 2).trim().split(/\s+/)
    const utime = Number(f[11]), stime = Number(f[12]), start = Number(f[19]), rss = Number(f[21])
    if (![utime, stime, start, rss].every(Number.isFinite)) return null
    return { pid, comm: text.slice(open + 1, close), ticks: utime + stime, rss, start }
}

/**
 * Group processes by WATCH, each group's cpu as a percent of one core. With
 * `prev` (each pid's ticks at the last sample, `dt` seconds ago), over that
 * interval; a pid that wasn't there then started since, so all its ticks are
 * the interval's. Without (the first sample), over each one's life so far,
 * as ps reports it.
 */
export function groupStats(now: ProcStat[], prev: Map<number, number> | null, o: { dt: number; hz: number; page: number; uptime: number }): ProcInfo[] {
    const agg = new Map<string, ProcInfo>()
    for (const p of now) {
        const w = WATCH.find((x) => x.test(p.comm))
        if (!w) continue
        const cur = agg.get(w.key) || { name: w.key, count: 0, cpu: 0, mem: 0 }
        cur.count++
        cur.mem += p.rss * o.page
        if (prev && o.dt > 0) {
            const before = prev.get(p.pid)
            // Fewer ticks than before is a reused pid: a new process.
            const used = before != null && p.ticks >= before ? p.ticks - before : p.ticks
            cur.cpu += (used / o.hz / o.dt) * 100
        } else {
            const life = o.uptime - p.start / o.hz
            if (life > 0) cur.cpu += (p.ticks / o.hz / life) * 100
        }
        agg.set(w.key, cur)
    }
    return Array.from(agg.values())
        .map((p) => ({ ...p, cpu: Math.round(p.cpu * 10) / 10 }))
        .sort((a, b) => b.mem - a.mem)
}

/** Every process's stat, or null where there's no /proc (macOS). */
export function readProcStats(): ProcStat[] | null {
    let pids: string[]
    try {
        pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d))
    } catch {
        return null
    }
    const out: ProcStat[] = []
    for (const d of pids) {
        try {
            const s = parseStat(Number(d), readFileSync(`/proc/${d}/stat`, "utf8"))
            if (s) out.push(s)
        } catch {
            // It exited between the listing and the read.
        }
    }
    return out
}

// The last sample's ticks per pid, and when it was taken.
let last: { at: number; ticks: Map<number, number> } | null = null
let hz = 0, page = 0
const conf = (name: string, fallback: number) => {
    try {
        return Number(execSync(`getconf ${name}`, { encoding: "utf8", timeout: 2000 }).trim()) || fallback
    } catch {
        return fallback
    }
}

/** A Linux host's named processes from /proc, cpu since the last call; null where there's no /proc. */
export function sampleProcesses(): ProcInfo[] | null {
    const stats = readProcStats()
    if (!stats) return null
    if (!hz) { hz = conf("CLK_TCK", 100); page = conf("PAGESIZE", 4096) }
    let uptime = 0
    try { uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) || 0 } catch { /* lifetime cpu reads 0 */ }
    const at = Date.now()
    const groups = groupStats(stats, last?.ticks ?? null, { dt: last ? (at - last.at) / 1000 : 0, hz, page, uptime })
    last = { at, ticks: new Map(stats.map((s) => [s.pid, s.ticks])) }
    return groups
}

export function parseProcesses(out: string): ProcInfo[] {
    const agg = new Map<string, ProcInfo>()
    for (const line of String(out || "").split("\n")) {
        // Last two whitespace-separated tokens are rss + pcpu; the rest is comm
        // (which may itself contain spaces/slashes, e.g. node process titles).
        const m = line.trim().match(/^(.+?)\s+(\d+)\s+([\d.]+)$/)
        if (!m) continue
        const comm = m[1].trim()
        const w = WATCH.find((x) => x.test(comm))
        if (!w) continue
        const cur = agg.get(w.key) || { name: w.key, count: 0, cpu: 0, mem: 0 }
        cur.count++
        cur.cpu += Number(m[3]) || 0
        cur.mem += (Number(m[2]) || 0) * 1024 // rss KiB -> bytes
        agg.set(w.key, cur)
    }
    return Array.from(agg.values())
        .map((p) => ({ ...p, cpu: Math.round(p.cpu * 10) / 10 }))
        .sort((a, b) => b.mem - a.mem)
}
