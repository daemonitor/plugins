import { execFile } from "node:child_process"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// Runs Nagios-compatible check commands and reports each as its own service.
//
// The Nagios plugin format is the lingua franca of host checks: the whole
// monitoring-plugins package (check_disk, check_http, check_ssl_cert, ...),
// and anything written for Icinga, Naemon or Sensu, speaks it. The exit code
// is the state (0 OK, 1 WARNING, 2 CRITICAL, 3 UNKNOWN), the first line of
// output is the status text, and anything after "|" is performance data.
//
// Commands come ONLY from this host's local config, never from the server.
// A server that could send commands could run anything on every agent.
//
// Commands run with execFile and an argument array: no shell, so nothing in
// an argument is interpreted. Use `["sh", "-c", "..."]` if you want a shell.

interface NagiosCheck {
  name: string
  command: string[] // [binary, ...args]
  timeout?: number // seconds, default 30
  env?: Record<string, string>
}

interface NagiosConfig {
  checks?: NagiosCheck[]
  refreshInterval?: number // ms, default 60000
  timeout?: number // default per-check timeout, seconds
  pluginDir?: string // resolve bare command names here first, e.g. /usr/lib/nagios/plugins
}

export type NagiosState = "ok" | "warning" | "critical" | "unknown"

export interface Perfdatum {
  label: string
  value: number
  uom?: string
  warn?: string
  crit?: string
  min?: number
  max?: number
}

const STATES: NagiosState[] = ["ok", "warning", "critical", "unknown"]
// Output is capped: a check printing a megabyte would otherwise be sent every
// minute and stored in history.
const MAX_OUTPUT = 4000

export function stateOf(exitCode: number | null): NagiosState {
  return exitCode != null && exitCode >= 0 && exitCode <= 3 ? STATES[exitCode] : "unknown"
}

const num = (s?: string) => (s == null || s === "" || Number.isNaN(Number(s)) ? undefined : Number(s))

/**
 * Parse performance data: space-separated `'label'=value[UOM];[warn];[crit];[min];[max]`.
 * Labels may be quoted to contain spaces, with '' standing for a literal quote.
 * Malformed items are skipped rather than failing the whole check.
 */
export function parsePerfdata(raw: string): Perfdatum[] {
  const out: Perfdatum[] = []
  const re = /\s*('(?:[^']|'')+'|[^\s=']+)=(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const label = m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]
    const [valueUom, warn, crit, min, max] = m[2].split(";")
    const vm = valueUom.match(/^(-?[\d.]+(?:[eE][-+]?\d+)?)([a-zA-Z%]*)$/)
    if (!vm) continue // "U" (undetermined) or garbage
    out.push({
      label,
      value: Number(vm[1]),
      ...(vm[2] ? { uom: vm[2] } : {}),
      ...(warn ? { warn } : {}),
      ...(crit ? { crit } : {}),
      ...(num(min) != null ? { min: num(min) } : {}),
      ...(num(max) != null ? { max: num(max) } : {}),
    })
  }
  return out
}

/**
 * Split plugin output into the status line, the long output and perfdata.
 * Perfdata can follow "|" on the first line and on any long-output line after
 * a "|" there (the Nagios 3 multi-line form).
 */
export function parseOutput(stdout: string): { output: string; longOutput?: string; perfdata: Perfdatum[] } {
  const lines = stdout.replace(/\r/g, "").replace(/\n+$/, "").split("\n")
  const [first = "", ...rest] = lines
  const [output, firstPerf = ""] = splitPipe(first)
  let perf = firstPerf
  const long: string[] = []
  let inPerf = false
  for (const line of rest) {
    if (inPerf) { perf += " " + line; continue }
    const [text, more] = splitPipe(line)
    if (text.trim()) long.push(text.trimEnd())
    if (more != null) { perf += " " + more; inPerf = true }
  }
  return {
    output: output.trim(),
    ...(long.length ? { longOutput: long.join("\n").slice(0, MAX_OUTPUT) } : {}),
    perfdata: parsePerfdata(perf),
  }
}

function splitPipe(line: string): [string, string?] {
  const i = line.indexOf("|")
  return i < 0 ? [line] : [line.slice(0, i), line.slice(i + 1)]
}

export interface CheckResult {
  name: string
  command: string // the binary only: arguments can carry passwords
  state: NagiosState
  exitCode: number | null
  output: string
  longOutput?: string
  perfdata: Perfdatum[]
  durationMs: number
  timedOut?: boolean
  error?: string
}

export async function runCheck(check: NagiosCheck, defaults: { timeout?: number; pluginDir?: string } = {}): Promise<CheckResult> {
  const [bin, ...args] = check.command
  const resolved = defaults.pluginDir && !bin.includes("/") ? `${defaults.pluginDir.replace(/\/$/, "")}/${bin}` : bin
  const timeoutMs = (check.timeout ?? defaults.timeout ?? 30) * 1000
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      resolved,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...process.env, ...(check.env || {}) }, killSignal: "SIGKILL" },
      (err: any, stdout, stderr) => {
        const durationMs = Date.now() - started
        const base = { name: check.name, command: bin.split("/").pop() || bin, durationMs }
        // A non-zero exit is the plugin reporting a state, not a failure to run.
        const exitCode: number | null = err ? (typeof err.code === "number" ? err.code : null) : 0
        if (err && err.killed) {
          return resolve({ ...base, state: "unknown", exitCode: null, output: `Check timed out after ${timeoutMs / 1000}s`, perfdata: [], timedOut: true })
        }
        if (err && exitCode == null) {
          // Couldn't start it at all: ENOENT, EACCES and so on.
          return resolve({ ...base, state: "unknown", exitCode: null, output: `Could not run ${base.command}: ${err.code || err.message}`, perfdata: [], error: String(err.message || err).slice(0, 300) })
        }
        const parsed = parseOutput(String(stdout || stderr || "").slice(0, MAX_OUTPUT))
        resolve({ ...base, state: stateOf(exitCode), exitCode, ...parsed, output: parsed.output || "(no output)" })
      },
    )
  })
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

export function createNagiosPlugin() {
  let refreshTimer: any = null
  let running = false

  const checksOf = (plugin: MonitoringPluginBase): NagiosCheck[] => {
    const cfg = (plugin.config || {}) as NagiosConfig
    return (Array.isArray(cfg.checks) ? cfg.checks : []).filter(
      (c) => c?.name && Array.isArray(c.command) && c.command.length && c.command.every((a) => typeof a === "string"),
    )
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    // A slow check must not pile up overlapping runs of itself.
    if (running) return
    running = true
    try {
      const cfg = (plugin.config || {}) as NagiosConfig
      await Promise.all(
        checksOf(plugin).map(async (check) => {
          const result = await runCheck(check, cfg)
          // The interval tells the dashboard how long silence is normal, so a
          // check that runs every 10 minutes doesn't read OFFLINE in between.
          await plugin.send({ ...result, intervalMs: cfg.refreshInterval || 60000 }, `nagios-${slug(check.name)}`)
        }),
      )
    } finally {
      running = false
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const n = checksOf(plugin).length
    if (!n) console.warn("nagios: no valid checks configured (each needs a name and a command array)")
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as NagiosConfig)?.refreshInterval || 60000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin("nagios", "nagios", "Nagios-compatible check commands", async () => {}, monitorFn, refreshFn, teardownFn)
}

export default createNagiosPlugin
