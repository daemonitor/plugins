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

// True available memory. os.freemem() returns only truly-free memory, which on
// both Linux and macOS excludes large amounts of reclaimable memory (page cache /
// inactive / speculative), making hosts look near-full. Use the OS's own estimate
// of obtainable-without-pressure memory instead.
function availableMem(): number {
    const plat = platform()
    if (plat === "linux") {
        try {
            const info = readFileSync("/proc/meminfo", "utf8")
            const m = info.match(/^MemAvailable:\s+(\d+)\s*kB/m)
            if (m) return parseInt(m[1], 10) * 1024
        } catch {
            // fall through to freemem()
        }
    }
    if (plat === "darwin") {
        // macOS reclaimable ≈ free + inactive + speculative + purgeable pages
        // (matches "available" — the rest is app/wired/compressed).
        try {
            const out = execSync("vm_stat", { encoding: "utf8", timeout: 3000 })
            const ps = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 4096
            const pages = (label: string) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0
            const avail = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * ps
            if (avail > 0) return avail
        } catch {
            // fall through to freemem()
        }
    }
    return freemem()
}

// Host OS metrics: cpu (from cpus().times), memory, load, uptime, addresses.
// Matches the frontend `os` fleetAdapter case.
export function createOSPlugin() {
    let refreshTimer: any = null

    const collect = () => {
        const interfaces = networkInterfaces()
        const addresses: Record<string, { address: string; netmask: string; mac: string }> = {}
        for (const [key, value] of Object.entries(interfaces)) {
            if (!value) continue
            const found = value.find((p) => p.family === "IPv4" && p.internal !== true)
            if (found) addresses[key] = { address: found.address, netmask: found.netmask, mac: found.mac }
        }
        return {
            addresses,
            totalmem: totalmem(),
            freemem: freemem(),
            available: availableMem(),
            disks: collectDisks(),
            processes: collectProcesses(),
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
