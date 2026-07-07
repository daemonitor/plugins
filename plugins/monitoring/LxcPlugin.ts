import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"
import { exec } from "child_process"
import { promisify } from "util"
import { hostname } from "os"
import { parseProcesses, PS_CMD, type ProcInfo } from "../../lib/processes"

const execAsync = promisify(exec)
const EXEC_OPTS = { maxBuffer: 32 * 1024 * 1024 }

// NOTE: LXC is Linux-only. This plugin is written to the documented shape of
// `lxc list --format json` (also compatible with Incus via lxcBin: "incus"),
// but has NOT been exercised against a live daemon yet — validate on a real
// LXD/Incus host before relying on it.

interface Container {
  id: string
  name: string
  service: string
  image: string
  state: string
  status: string
  running: boolean
  health: string
  cpu: number
  mem: number
  memLimit: number
  memPercent: number
  restarts: number
  exitCode: number
  processes?: ProcInfo[]
}

/** Parse LXD memory-limit strings like "1GB", "512MiB", "2GiB" to bytes. */
function limitToBytes(value?: string): number {
  if (!value) return 0
  const unit = String(value).replace(/[0-9.\s]/g, "").toUpperCase()
  const num = parseFloat(String(value).replace(/[^0-9.]/g, "")) || 0
  const mult: Record<string, number> = {
    "": 1, B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2,
    GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4,
  }
  return Math.round(num * (mult[unit] ?? 1))
}

export function createLxcPlugin() {
  let refreshTimer: any = null
  let available = false
  let lxcBin = "lxc"
  // cumulative CPU usage (ns) + wall clock (ms) per instance, for %-of-core calc
  const prevCpu = new Map<string, { usage: number; t: number }>()

  const setupFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    lxcBin = plugin.config?.lxcBin || plugin.config?.bin || "lxc"
    try {
      await execAsync(`${lxcBin} version`, EXEC_OPTS)
      available = true
    } catch (err) {
      available = false
      console.error(`lxc: "${lxcBin}" not available — plugin idle:`, (err as Error).message)
    }
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    if (!available) return
    try {
      const { stdout } = await execAsync(`${lxcBin} list --format json`, EXEC_OPTS)
      const instances: any[] = JSON.parse(stdout || "[]")

      const only: string[] = plugin.config?.instances || []
      const exclude: string[] = plugin.config?.exclude || []
      const host = hostname()
      const now = Date.now()

      const groups = new Map<string, Container[]>()
      for (const inst of instances) {
        const name = inst.name
        if (!name) continue
        if (only.length && !only.includes(name)) continue
        if (exclude.includes(name)) continue

        const running = String(inst.status || "").toLowerCase() === "running"
        const st = inst.state || {}

        // CPU %: delta of cumulative usage(ns) over wall time -> % of one core
        const usage = Number(st.cpu?.usage) || 0
        let cpu = 0
        const p = prevCpu.get(name)
        if (running && p && now > p.t) {
          const dUsage = usage - p.usage
          const dWallNs = (now - p.t) * 1e6
          if (dWallNs > 0 && dUsage >= 0) cpu = Math.round((dUsage / dWallNs) * 1000) / 10
        }
        prevCpu.set(name, { usage, t: now })

        const mem = Number(st.memory?.usage) || 0
        const memLimit = limitToBytes(inst.config?.["limits.memory"] || inst.expanded_config?.["limits.memory"])
        const memPercent = memLimit ? Math.round((mem / memLimit) * 1000) / 10 : 0

        const container: Container = {
          id: name,
          name,
          service: "",
          image: inst.config?.["image.description"] || inst.type || "lxc",
          state: String(inst.status || "").toLowerCase(),
          status: inst.status || "",
          running,
          health: "",
          cpu,
          mem,
          memLimit,
          memPercent,
          restarts: 0,
          exitCode: 0,
        }

        // Named service processes inside the container (nginx / php-fpm / db …),
        // sampled from the host via `lxc exec` — no agent needed in the container.
        if (running) {
          try {
            const { stdout: pout } = await execAsync(`${lxcBin} exec ${name} -- ${PS_CMD}`, { ...EXEC_OPTS, timeout: 8000 })
            container.processes = parseProcesses(pout)
          } catch {
            container.processes = []
          }
        }

        // Grouping: a user.daemonitor.group config key, else the host.
        const group = inst.config?.["user.daemonitor.group"] ||
          inst.expanded_config?.["user.daemonitor.group"] || host
        const arr = groups.get(group) || []
        arr.push(container)
        groups.set(group, arr)
      }

      for (const [project, containers] of groups) {
        const running = containers.filter((c) => c.running).length
        const payload = {
          name: project,
          engine: "lxc",
          host,
          project,
          running,
          total: containers.length,
          containers,
          timestamp: now,
        }
        await plugin.send(payload, `lxc-${project}`)
      }
    } catch (err) {
      console.error("lxc: refresh error:", (err as Error).message)
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    if (!available) return
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), plugin.config?.refreshInterval || 60000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "lxc",
    "lxc",
    "LXC / LXD / Incus container monitoring plugin",
    setupFn,
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createLxcPlugin
