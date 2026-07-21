import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"
import {
    arch, cpus, freemem, hostname, loadavg, networkInterfaces,
    platform, release, totalmem, type, uptime,
} from "os"
import { readFileSync } from "fs"
import { execSync } from "child_process"
import { parseProcesses, PS_CMD, type ProcInfo } from "../../lib/processes"

// Named service processes (nginx / php-fpm / db / …) running on the host.
function collectProcesses(): ProcInfo[] {
    try {
        return parseProcesses(execSync(PS_CMD, { encoding: "utf8", timeout: 5000 }))
    } catch {
        return []
    }
}

interface Disk {
    device: string
    fstype: string
    mount: string
    total: number
    used: number
    free: number
    pct: number
}

// Pseudo / virtual filesystems that aren't real drives.
const PSEUDO_FS = new Set([
    "tmpfs", "devtmpfs", "squashfs", "overlay", "overlayfs", "aufs", "proc", "sysfs",
    "cgroup", "cgroup2", "mqueue", "debugfs", "tracefs", "devpts", "ramfs", "nsfs",
    "binfmt_misc", "configfs", "pstore", "efivarfs", "autofs", "fusectl", "securityfs",
    "hugetlbfs", "none", "fuse.gvfsd-fuse", "fuse.portal", "fuse.snapfuse",
])

// Real, physical/attached drives only. Shells out to `df` and filters out
// pseudo filesystems, loop/snap mounts, and bind-mount duplicates.
function collectDisks(): Disk[] {
    try {
        const darwin = platform() === "darwin"
        // Linux: `-T` gives the fstype column; bytes via --block-size=1.
        // macOS: no fstype flag, `-l` restricts to local filesystems.
        const cmd = darwin ? "df -kl" : "df -PT --block-size=1"
        const out = execSync(cmd, { encoding: "utf8", timeout: 5000 })
        const raw: Disk[] = []
        for (const line of out.split("\n").slice(1)) {
            const p = line.trim().split(/\s+/)
            if (p.length < 6) continue
            let device: string, fstype: string, total: number, used: number, free: number, mount: string
            if (darwin) {
                // Filesystem 1K-blocks Used Avail Capacity iused ifree %iused Mounted-on
                device = p[0]; fstype = ""
                total = (Number(p[1]) || 0) * 1024
                used = (Number(p[2]) || 0) * 1024
                free = (Number(p[3]) || 0) * 1024
                mount = p.slice(8).join(" ")
                if (!device.startsWith("/dev/")) continue
                // macOS/APFS spawns many synthetic /dev/diskNsM volumes. The real
                // main-disk usage lives on the Data volume (the "/" snapshot reads
                // near-empty); real external drives mount under /Volumes. Drop the
                // rest (/System/Volumes/*, CoreSimulator, etc.).
                if (mount === "/System/Volumes/Data") mount = "/"
                else if (mount !== "/" && !mount.startsWith("/Volumes/")) continue
            } else {
                // Filesystem Type 1B-blocks Used Available Capacity Mounted-on
                device = p[0]; fstype = p[1]
                total = Number(p[2]) || 0
                used = Number(p[3]) || 0
                free = Number(p[4]) || 0
                mount = p.slice(6).join(" ")
                if (PSEUDO_FS.has(fstype)) continue
            }
            if (total <= 0 || device === "overlay" || device === "none" || device.startsWith("/dev/loop")) continue
            raw.push({ device, fstype, mount, total, used, free, pct: total ? Math.round((used / total) * 100) : 0 })
        }
        // Dedupe by mount, keeping the fullest entry — collapses bind mounts, and on
        // macOS picks the real Data volume over the near-empty read-only "/" snapshot.
        const byMount = new Map<string, Disk>()
        for (const d of raw) {
            const cur = byMount.get(d.mount)
            if (!cur || d.used > cur.used) byMount.set(d.mount, d)
        }
        return Array.from(byMount.values()).sort((a, b) => b.pct - a.pct)
    } catch {
        return []
    }
}

// True available memory: on Linux, os.freemem() returns MemFree, which excludes
// reclaimable page cache and makes hosts look near-full. MemAvailable is the
// kernel's estimate of memory obtainable without swapping. Fall back to freemem()
// on non-Linux (or if /proc is unreadable).
function availableMem(): number {
    if (platform() === "linux") {
        try {
            const info = readFileSync("/proc/meminfo", "utf8")
            const m = info.match(/^MemAvailable:\s+(\d+)\s*kB/m)
            if (m) return parseInt(m[1], 10) * 1024
        } catch {
            // fall through to freemem()
        }
    }
    return freemem()
}

// Cumulative rx/tx byte counters summed across real interfaces (Linux
// /proc/net/dev). Loopback and virtual bridges (docker/veth/lxc/br-) are skipped
// so the figure reflects actual host network traffic, not container-to-host
// chatter. Returns null off Linux (rate is then omitted, not faked).
function readNetTotals(): { rx: number; tx: number } | null {
    if (platform() !== "linux") return null
    try {
        const data = readFileSync("/proc/net/dev", "utf8")
        let rx = 0, tx = 0
        for (const line of data.split("\n")) {
            const m = line.match(/^\s*([^:]+):\s*(.*)$/)
            if (!m) continue
            const iface = m[1].trim()
            if (iface === "lo" || /^(veth|docker|br-|lxcbr|virbr|tap|tun)/.test(iface)) continue
            const cols = m[2].trim().split(/\s+/).map(Number)
            rx += cols[0] || 0   // column 1 = rx bytes
            tx += cols[8] || 0   // column 9 = tx bytes
        }
        return { rx, tx }
    } catch {
        return null
    }
}

// Host OS metrics: cpu (from cpus().times), memory, disk, load, uptime,
// addresses, and network throughput. Matches the frontend `os` fleetAdapter case.
export function createOSPlugin() {
    let refreshTimer: any = null
    // Previous cumulative net counters, to derive a per-second rate across polls.
    let prevNet: { rx: number; tx: number; ts: number } | null = null

    const collect = () => {
        const interfaces = networkInterfaces()
        const addresses: Record<string, { address: string; netmask: string; mac: string }> = {}
        for (const [key, value] of Object.entries(interfaces)) {
            if (!value) continue
            const found = value.find((p) => p.family === "IPv4" && p.internal !== true)
            if (found) addresses[key] = { address: found.address, netmask: found.netmask, mac: found.mac }
        }

        // Network throughput: bytes/sec since the previous sample. The first poll
        // has no baseline, so rate is omitted (undefined) rather than a bogus 0.
        let network: { rxBytes: number; txBytes: number; rxRate: number; txRate: number } | undefined
        const totals = readNetTotals()
        if (totals) {
            const now = Date.now()
            if (prevNet) {
                const dt = (now - prevNet.ts) / 1000
                if (dt > 0) {
                    network = {
                        rxBytes: totals.rx,
                        txBytes: totals.tx,
                        rxRate: Math.max(0, Math.round((totals.rx - prevNet.rx) / dt)),
                        txRate: Math.max(0, Math.round((totals.tx - prevNet.tx) / dt)),
                    }
                }
            }
            prevNet = { rx: totals.rx, tx: totals.tx, ts: now }
        }

        return {
            addresses,
            totalmem: totalmem(),
            freemem: freemem(),
            available: availableMem(),
            disks: collectDisks(),
            processes: collectProcesses(),
            network,
            loadavg: loadavg(),
            uptime: uptime(),
            hostname: hostname(),
            platform: platform(),
            release: release(),
            type: type(),
            arch: arch(),
            cpus: cpus(),
        }
    }

    const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
        try {
            await plugin.send({ name: hostname(), ...collect() }, "os")
        } catch (err) {
            console.error("os: refresh error:", (err as Error).message)
        }
    }

    const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
        await refreshFn(plugin)
        refreshTimer = setInterval(() => refreshFn(plugin), plugin.config?.refreshInterval || 30000)
    }

    const teardownFn = async (): Promise<void> => {
        if (refreshTimer) clearInterval(refreshTimer)
        refreshTimer = null
    }

    return createMonitoringPlugin(
        "os",
        "os",
        "Host OS monitoring plugin",
        async () => {},
        monitorFn,
        refreshFn,
        teardownFn,
    )
}

export default createOSPlugin
