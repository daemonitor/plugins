// Aggregate named service processes (nginx, php-fpm, db, …) from `ps` output.
// Used for host processes (OSPlugin) and per-container processes (LxcPlugin via
// `lxc exec … ps`). MEM (rss) is exact; CPU is `ps` %cpu, which is the average
// over each process's lifetime — a rough indicator for long-running daemons.

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
