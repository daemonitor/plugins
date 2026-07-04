import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"
import { exec } from "child_process"
import { promisify } from "util"
import { hostname } from "os"

const execAsync = promisify(exec)
const EXEC_OPTS = { maxBuffer: 32 * 1024 * 1024 } // containers.length can be large

interface Container {
  id: string
  name: string
  service: string
  image: string
  state: string        // running | exited | created | paused | restarting
  status: string       // human string, e.g. "Up 2 days (healthy)"
  running: boolean
  health: string       // healthy | unhealthy | starting | ''
  cpu: number          // percent
  mem: number          // bytes used
  memLimit: number     // bytes limit
  memPercent: number
  restarts: number
  exitCode: number
}

const HEALTH_RE = /\((healthy|unhealthy|health: starting|starting)\)/i

/** Convert docker's "83.86MiB" / "1.952GiB" memory strings to bytes. */
function memToBytes(value: string): number {
  if (!value) return 0
  const unit = value.replace(/[0-9.\s]/g, "").toUpperCase()
  const num = parseFloat(value.replace(/[^0-9.]/g, "")) || 0
  const mult: Record<string, number> = {
    B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2,
    GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4,
  }
  return Math.round(num * (mult[unit] ?? 1))
}

/**
 * Collect all containers (including stopped) in a small, fixed number of
 * exec calls regardless of how many containers exist:
 *   1. `docker ps -a`      — names, image, state, status, compose labels
 *   2. `docker stats`      — live CPU / memory for running containers (one batch)
 *   3. `docker inspect`    — restart count, health, exit code (one batch)
 */
async function collectContainers(bin: string): Promise<Container[]> {
  const psFmt = '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}'
  const { stdout: psOut } = await execAsync(`${bin} ps -a --format '${psFmt}'`, EXEC_OPTS)

  const containers: Container[] = []
  const byId = new Map<string, Container>()
  for (const line of psOut.split("\n")) {
    if (!line.trim()) continue
    const [id, name, image, state, status, project, service] = line.split("|")
    const running = (state || "").toLowerCase() === "running"
    const healthMatch = HEALTH_RE.exec(status || "")
    const c: Container = {
      id,
      name,
      service: service || "",
      image,
      state: state || "",
      status: status || "",
      running,
      health: healthMatch ? healthMatch[1].replace(/^health:\s*/i, "").toLowerCase() : "",
      cpu: 0, mem: 0, memLimit: 0, memPercent: 0, restarts: 0, exitCode: 0,
    }
    ;(c as any).__project = project || ""
    containers.push(c)
    byId.set(id, c)
  }

  if (!containers.length) return containers

  // 2. live stats for running containers (one batched call, best-effort)
  try {
    const { stdout: statsOut } = await execAsync(
      `${bin} stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'`,
      EXEC_OPTS,
    )
    for (const line of statsOut.split("\n")) {
      if (!line.trim()) continue
      const [id, cpuPerc, memUsage, memPerc] = line.split("|")
      const c = byId.get(id)
      if (!c) continue
      c.cpu = parseFloat((cpuPerc || "").replace("%", "")) || 0
      const [used, limit] = (memUsage || "").split("/").map((p) => p.trim())
      c.mem = memToBytes(used)
      c.memLimit = memToBytes(limit)
      c.memPercent = parseFloat((memPerc || "").replace("%", "")) || 0
    }
  } catch (err) {
    console.error("docker: stats collection failed:", (err as Error).message)
  }

  // 3. restart count + exit code (one batched inspect, best-effort).
  // NOTE: we deliberately do NOT read .State.Health here — on some engines the
  // template errors with `map has no entry for key "Health"` for containers
  // without a healthcheck, which would fail the whole batch. Health is parsed
  // from the ps `Status` string ("(healthy)" / "(unhealthy)") instead.
  try {
    const ids = containers.map((c) => c.id).join(" ")
    const inspectFmt = '{{.Id}}|{{.RestartCount}}|{{.State.ExitCode}}'
    const { stdout: inspOut } = await execAsync(`${bin} inspect --format '${inspectFmt}' ${ids}`, EXEC_OPTS)
    for (const line of inspOut.split("\n")) {
      if (!line.trim()) continue
      const [fullId, restarts, exitCode] = line.split("|")
      const c = byId.get(fullId.slice(0, 12))
      if (!c) continue
      c.restarts = parseInt(restarts, 10) || 0
      c.exitCode = parseInt(exitCode, 10) || 0
    }
  } catch (err) {
    console.error("docker: inspect collection failed:", (err as Error).message)
  }

  return containers
}

export function createDockerPlugin() {
  let refreshTimer: any = null
  let available = false
  let dockerBin = "docker"

  const setupFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    dockerBin = plugin.config?.dockerBin || plugin.config?.bin || "docker"
    try {
      await execAsync(`${dockerBin} version --format '{{.Server.Version}}'`, EXEC_OPTS)
      available = true
    } catch (err) {
      // Don't throw: a missing docker engine shouldn't take down the whole client.
      available = false
      console.error(`docker: engine not available via "${dockerBin}" — plugin idle:`, (err as Error).message)
    }
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    if (!available) return
    try {
      const all = await collectContainers(dockerBin)

      // Optional filtering by compose project.
      const only: string[] = plugin.config?.projects || []
      const exclude: string[] = plugin.config?.exclude || []

      // Group by compose project (standalone containers group under their own name).
      const groups = new Map<string, Container[]>()
      for (const c of all) {
        const project = (c as any).__project || c.name
        delete (c as any).__project
        if (only.length && !only.includes(project)) continue
        if (exclude.includes(project)) continue
        const arr = groups.get(project) || []
        arr.push(c)
        groups.set(project, arr)
      }

      const host = hostname()
      for (const [project, containers] of groups) {
        const running = containers.filter((c) => c.running).length
        const payload = {
          name: project,
          engine: "docker",
          host,
          project,
          running,
          total: containers.length,
          containers,
          timestamp: Date.now(),
        }
        await plugin.send(payload, `docker-${project}`)
      }
    } catch (err) {
      console.error("docker: refresh error:", (err as Error).message)
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
    "docker",
    "docker",
    "Docker container monitoring plugin",
    setupFn,
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createDockerPlugin
