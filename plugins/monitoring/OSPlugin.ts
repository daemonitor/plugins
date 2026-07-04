import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"
import {
    arch, cpus, freemem, hostname, loadavg, networkInterfaces,
    platform, release, totalmem, type, uptime,
} from "os"

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
