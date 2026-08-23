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
  // Why the healthcheck is failing: its own last output, and how many
  // consecutive failures. Only collected for containers that are unhealthy.
  healthOutput?: string
  healthFailingStreak?: number
  // Exit code of the last healthcheck. Docker records -1 when it KILLED the
  // check for exceeding its timeout, which is a completely different fault from
  // the command running and returning non-zero — and it is the case that
  // produces no output at all, so without this there is nothing to report.
  healthExitCode?: number
  netIn?: number       // bytes/sec (rx), rate across polls
  netOut?: number      // bytes/sec (tx)
  blkRead?: number     // bytes/sec (block read)
  blkWrite?: number    // bytes/sec (block write)
}

/**
 * Reduce a healthcheck's captured output to the part that says what went wrong.
 *
 * Healthchecks are overwhelmingly `curl`, and curl writes its transfer meter to
 * the same buffer as the response — so the raw text is mostly columns of rates
 * and `--:--:--` padding, with the answer somewhere inside. Taking the first 300
 * characters, as this used to, returns the meter header every single time.
 *
 * curl also rewrites the meter line in place with \r while the body streams in,
 * so the response can land INSIDE a rate row rather than on its own line. That
 * rules out dropping noisy lines wholesale; the meter tokens have to come out
 * and whatever is left is the message.
 */
export function cleanHealthOutput(raw: string): string {
  const s = String(raw || "")
  // When curl itself failed it says so in one line, and that line is the entire
  // answer: exit 7 is connection refused, 28 is timeout, 22 is an HTTP error.
  const curlErr = s.match(/curl:\s*\(\d+\)[^\r\n]*/)
  if (curlErr) return curlErr[0].trim().slice(0, 300)
  const stripped = s
    .replace(/%\s*Total[\s\S]*?Dload\s+Upload\s+Total\s+Spent\s+Left\s+Speed/g, " ")
    .replace(/%\s*Total[^\r\n]*/g, " ")
    .replace(/Dload[^\r\n]*Speed/g, " ")
    .replace(/(?:--:--:--|\d+:\d{2}:\d{2})/g, " ")
    .replace(/\s+/g, " ")
    // what remains of the meter is runs of bare counters
    .replace(/(?:\s\d+(?:\.\d+)?[kKMG]?){3,}(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  // A failing command puts its error last, after whatever it managed to print.
  return stripped.length > 300 ? "…" + stripped.slice(-300) : stripped
}

const HEALTH_RE = /\((healthy|unhealthy|health: starting|starting)\)/i

// Previous cumulative NetIO/BlockIO totals per container id, to derive a
// per-second rate across polls. Module-level (one collect per host per cycle).
const ioPrev: Record<string, { rx: number; tx: number; rd: number; wr: number; ts: number }> = {}

// docker stats renders "12MB / 7.02MB" (rx / tx, or read / write). Split + convert.
function pairToBytes(value: string): { a: number; b: number } {
  const [x, y] = (value || "").split("/").map((p) => p.trim())
  return { a: memToBytes(x), b: memToBytes(y) }
}

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

  // 2. live stats for running containers (one batched call, best-effort).
  // NetIO/BlockIO are CUMULATIVE since container start, so we derive a per-second
  // rate from the delta vs the previous poll (first poll → no rate).
  try {
    const { stdout: statsOut } = await execAsync(
      `${bin} stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}'`,
      EXEC_OPTS,
    )
    const now = Date.now()
    const seen = new Set<string>()
    for (const line of statsOut.split("\n")) {
      if (!line.trim()) continue
      const [id, cpuPerc, memUsage, memPerc, netIO, blkIO] = line.split("|")
      const c = byId.get(id)
      if (!c) continue
      c.cpu = parseFloat((cpuPerc || "").replace("%", "")) || 0
      const [used, limit] = (memUsage || "").split("/").map((p) => p.trim())
      c.mem = memToBytes(used)
      c.memLimit = memToBytes(limit)
      c.memPercent = parseFloat((memPerc || "").replace("%", "")) || 0

      const net = pairToBytes(netIO)   // { a: rx, b: tx }
      const blk = pairToBytes(blkIO)   // { a: read, b: write }
      seen.add(id)
      const prev = ioPrev[id]
      if (prev && now > prev.ts) {
        const dt = (now - prev.ts) / 1000
        // Guard counter resets (container restart): negative delta → skip that field.
        if (net.a >= prev.rx) c.netIn = Math.round((net.a - prev.rx) / dt)
        if (net.b >= prev.tx) c.netOut = Math.round((net.b - prev.tx) / dt)
        if (blk.a >= prev.rd) c.blkRead = Math.round((blk.a - prev.rd) / dt)
        if (blk.b >= prev.wr) c.blkWrite = Math.round((blk.b - prev.wr) / dt)
      }
      ioPrev[id] = { rx: net.a, tx: net.b, rd: blk.a, wr: blk.b, ts: now }
    }
    // Drop prev samples for containers no longer present.
    for (const k of Object.keys(ioPrev)) if (!seen.has(k)) delete ioPrev[k]
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

  // 4. For UNHEALTHY containers only, read the healthcheck's own last output.
  //
  // "1/13 containers unhealthy" says a problem exists and nothing about what it
  // is. Docker already stores the failing command's output in
  // .State.Health.Log[] — that is the actual error text, and without it an alert
  // sends someone to ssh into the box to run the same healthcheck by hand.
  //
  // Read one container at a time and only for the unhealthy ones. The batched
  // inspect above avoids .State.Health because the template errors for
  // containers that have no healthcheck; a container reporting "(unhealthy)"
  // necessarily has one, so this is safe, and it is a handful of calls at most
  // precisely when something is wrong.
  const unhealthy = containers.filter((c) => c.health === "unhealthy").slice(0, 5)
  for (const c of unhealthy) {
    try {
      const { stdout } = await execAsync(`${bin} inspect --format '{{json .State.Health}}' ${c.id}`, EXEC_OPTS)
      const h = JSON.parse(stdout.trim() || "null")
      if (!h) continue
      c.healthFailingStreak = Number(h.FailingStreak) || 0
      const log: any[] = Array.isArray(h.Log) ? h.Log : []
      // Docker keeps the last five probes, and the newest one can be a PASS while
      // the container is still marked unhealthy — the status lags a recovery, and
      // a flapping check alternates. Quoting that pass is how an alert ends up
      // giving {"status":"ok"} as the reason something is broken. Report the most
      // recent probe that actually failed.
      const entry = [...log].reverse().find((e) => e && e.ExitCode !== 0) || log[log.length - 1] || null
      if (entry && typeof entry.ExitCode === "number") c.healthExitCode = entry.ExitCode
      if (entry?.Output) {
        const cleaned = cleanHealthOutput(entry.Output)
        if (cleaned) c.healthOutput = cleaned
      }
    } catch (err) {
      // Best-effort: an alert naming the container is still better than none.
      console.error(`docker: health log read failed for ${c.name}:`, (err as Error).message)
    }
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
