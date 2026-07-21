import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

// LAN device reachability monitor. Pings a configured list of devices (the
// office infrastructure — switch, printers, APs, extenders, PBX, router, NAS,
// phones — plus any hosts worth watching) and reports up/down + latency for
// each. No credentials needed: pure ICMP. Richer per-device metrics (printer
// toner/pages, switch ports) come from the companion SNMP plugin.
//
// One client_state per device (type "netdevice", uid net-<slug>), so each shows
// as its own service and can be grouped (e.g. under "New York Office").

const pexec = promisify(execFile)

interface NetDevice {
  name: string
  ip: string
  type?: string // switch | printer | router | ap | extender | pbx | nas | phone | host | camera | ...
  mac?: string
  // Latency over this many ms → warning (default 200). Down is always error.
  warnMs?: number
}

interface NetScanConfig {
  devices?: NetDevice[]
  refreshInterval?: number // default 30s
  pingCount?: number // echoes per device (default 2)
  pingTimeout?: number // per-echo timeout seconds (default 2)
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

// Ping via the system `ping` (works unprivileged in a host-network container).
// Returns reachability + average RTT in ms. Never throws — an unreachable host
// exits non-zero, which we read as down.
async function pingHost(ip: string, count: number, timeout: number): Promise<{ up: boolean; latency?: number; loss?: number }> {
  try {
    const { stdout } = await pexec("ping", ["-c", String(count), "-W", String(timeout), ip], {
      timeout: (timeout * count + 2) * 1000,
    })
    // "rtt min/avg/max/mdev = 0.3/0.5/0.7/0.1 ms" (iputils) or a single "time=x ms"
    const avg = stdout.match(/=\s*[\d.]+\/([\d.]+)\//)
    const single = stdout.match(/time[=<]\s*([\d.]+)/)
    const lossM = stdout.match(/([\d.]+)%\s*packet loss/)
    const latency = avg ? parseFloat(avg[1]) : single ? parseFloat(single[1]) : undefined
    const loss = lossM ? parseFloat(lossM[1]) : undefined
    // 100% loss can still exit 0 on some ping builds — treat as down.
    if (loss === 100) return { up: false, latency: undefined, loss }
    return { up: true, latency: latency != null ? Math.round(latency * 10) / 10 : undefined, loss }
  } catch {
    return { up: false }
  }
}

export function createNetScanPlugin() {
  let refreshTimer: any = null

  const devicesOf = (plugin: MonitoringPluginBase): NetDevice[] => {
    const cfg = (plugin.config || {}) as NetScanConfig
    return Array.isArray(cfg.devices) ? cfg.devices.filter((d) => d?.ip) : []
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as NetScanConfig
    const count = cfg.pingCount || 2
    const timeout = cfg.pingTimeout || 2
    const devices = devicesOf(plugin)
    // Ping all devices concurrently — a scan of ~dozens stays well under the
    // refresh interval.
    await Promise.all(
      devices.map(async (d) => {
        const r = await pingHost(d.ip, count, timeout)
        await plugin.send(
          {
            name: d.name,
            ip: d.ip,
            type: d.type || "host",
            mac: d.mac,
            up: r.up,
            latency: r.latency,
            loss: r.loss,
            warnMs: d.warnMs ?? 200,
          },
          `net-${slug(d.name || d.ip)}`,
        )
      }),
    )
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as NetScanConfig)?.refreshInterval || 30000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "netscan",
    "netscan",
    "LAN device reachability (ping) monitor",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createNetScanPlugin
