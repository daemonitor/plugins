import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// Supabase cloud project monitor. Runs on any agent: it only makes HTTPS calls.
//
// Two sources, each optional and each behind its own credential, so a project
// can be watched with whichever one its owner is willing to hand over:
//
//   accessToken  Management API (api.supabase.com). Project status, which is
//                the only place "paused" shows up, and per-service health for
//                db, auth, rest, realtime, storage and the pooler. A personal
//                access token covers every project in ITS account.
//   serviceKey   The project's own Prometheus endpoint. Disk, memory,
//                connections and database size. Scoped to one project.
//
// Projects are listed one by one and each may carry its own accessToken,
// because the projects one agent watches routinely sit in different Supabase
// accounts. The top-level accessToken is the default for those that don't.
//
// One report per project, keyed supabase-<ref>. Severity is decided
// server-side (server/utils/supabase.ts), as with every other plugin: this one
// reports facts and the thresholds it was configured with.

interface SupabaseProject {
  /** Project ref: the subdomain in https://<ref>.supabase.co */
  ref: string
  name?: string
  accessToken?: string
  serviceKey?: string
}

interface SupabaseConfig {
  projects?: SupabaseProject[]
  /** Default personal access token for projects without their own. */
  accessToken?: string
  /** Services asked of the health endpoint. Drop one a project doesn't use. */
  services?: string[]
  diskWarnPct?: number
  diskCritPct?: number
  connWarnPct?: number
  requestTimeout?: number
  refreshInterval?: number
}

const DEFAULTS = {
  services: ["auth", "db", "pooler", "realtime", "rest", "storage"],
  diskWarnPct: 80,
  diskCritPct: 90,
  connWarnPct: 85,
  requestTimeout: 10000,
}

const MGMT = "https://api.supabase.com/v1"

export interface PromSample { name: string; labels: Record<string, string>; value: number }

/** Prometheus text exposition format, samples only. Comments and blanks are skipped. */
export function parseProm(text: string): PromSample[] {
  const out: PromSample[] = []
  for (const line of String(text || "").split("\n")) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line)
    if (!m) continue
    const value = Number(m[3])
    if (!Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    for (const l of (m[2] || "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2]
    out.push({ name: m[1], labels, value })
  }
  return out
}

/**
 * The handful of figures worth a tile, from the ~200 series the endpoint
 * serves. Every one is null when its series is absent, never 0: a missing
 * series means "not measured", and 0% disk would read as healthy.
 */
export function pickMetrics(samples: PromSample[]) {
  const all = (name: string) => samples.filter((s) => s.name === name)
  const sum = (name: string) => {
    const rows = all(name)
    return rows.length ? rows.reduce((n, s) => n + s.value, 0) : null
  }
  // Supabase keeps Postgres on its own volume at /data. Root is the fallback
  // for an image that does not split them.
  const onMount = (name: string) => {
    const rows = all(name)
    return (rows.find((s) => s.labels.mountpoint === "/data") ?? rows.find((s) => s.labels.mountpoint === "/"))?.value ?? null
  }
  const pct = (used: number | null, total: number | null) =>
    used != null && total ? Math.round((used / total) * 1000) / 10 : null

  const diskTotal = onMount("node_filesystem_size_bytes")
  const diskAvail = onMount("node_filesystem_avail_bytes")
  const diskUsed = diskTotal != null && diskAvail != null ? diskTotal - diskAvail : null
  const memTotal = sum("node_memory_MemTotal_bytes")
  const memAvail = sum("node_memory_MemAvailable_bytes")

  return {
    diskTotalBytes: diskTotal,
    diskUsedBytes: diskUsed,
    diskPct: pct(diskUsed, diskTotal),
    memPct: pct(memTotal != null && memAvail != null ? memTotal - memAvail : null, memTotal),
    load1: sum("node_load1"),
    connections: sum("pg_stat_database_num_backends"),
    maxConnections: sum("pg_settings_max_connections"),
    dbSizeBytes: sum("pg_database_size_bytes"),
  }
}

async function get(url: string, headers: Record<string, string>, timeout: number): Promise<Response> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`)
  return res
}

export async function collectProject(p: SupabaseProject, cfg: SupabaseConfig): Promise<any> {
  const token = p.accessToken || cfg.accessToken
  const timeout = cfg.requestTimeout ?? DEFAULTS.requestTimeout
  const base = { kind: "supabase", ref: p.ref, name: p.name || p.ref, timestamp: Date.now() }
  if (!token && !p.serviceKey) {
    return { ...base, reachable: false, error: "supabase project needs an accessToken or a serviceKey" }
  }

  const bearer = { Authorization: `Bearer ${token}`, Accept: "application/json" }
  const services = (cfg.services?.length ? cfg.services : DEFAULTS.services).join(",")
  const skipped = Promise.resolve(null)
  // Asked together, and one failing must not hide the others: a token that has
  // expired still leaves the disk figures worth reporting.
  const [project, health, prom] = await Promise.allSettled([
    token ? get(`${MGMT}/projects/${p.ref}`, bearer, timeout).then((r) => r.json()) : skipped,
    token ? get(`${MGMT}/projects/${p.ref}/health?services=${services}`, bearer, timeout).then((r) => r.json()) : skipped,
    p.serviceKey
      ? get(
          `https://${p.ref}.supabase.co/customer/v1/privileged/metrics`,
          { Authorization: `Basic ${Buffer.from(`service_role:${p.serviceKey}`).toString("base64")}` },
          timeout,
        ).then((r) => r.text())
      : skipped,
  ])

  const results = [project, health, prom]
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String(r.reason?.message || r.reason).slice(0, 160))
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null)
  const proj: any = value(project)
  const got = results.filter((r) => r.status === "fulfilled" && r.value != null).length
  if (!got) return { ...base, reachable: false, error: errors[0] || "no response" }

  const healthList: any[] = Array.isArray(value(health)) ? (value(health) as any[]) : []
  const promText = value(prom) as string | null
  return {
    ...base,
    name: p.name || proj?.name || p.ref,
    reachable: true,
    projectStatus: proj?.status ?? null,
    region: proj?.region ?? null,
    pgVersion: proj?.database?.version ?? null,
    services: healthList.map((s) => ({
      name: String(s?.name ?? "unknown"),
      healthy: s?.healthy === true,
      status: String(s?.status ?? "UNKNOWN"),
      error: s?.error ? String(s.error).slice(0, 160) : undefined,
    })),
    metrics: promText ? pickMetrics(parseProm(promText)) : null,
    // A source that was configured and failed. The report is partial, and the
    // server says so instead of showing a green tile with half its figures.
    errors,
    diskWarnPct: cfg.diskWarnPct ?? DEFAULTS.diskWarnPct,
    diskCritPct: cfg.diskCritPct ?? DEFAULTS.diskCritPct,
    connWarnPct: cfg.connWarnPct ?? DEFAULTS.connWarnPct,
  }
}

export function createSupabasePlugin() {
  let refreshTimer: any = null

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as SupabaseConfig
    const projects = (cfg.projects || []).filter((p) => p?.ref)
    if (!projects.length) {
      await plugin.send({ kind: "supabase", reachable: false, error: "supabase plugin needs at least one project ref" })
      return
    }
    // Sequential: a handful of projects, and one slow account must not be able
    // to starve the rest of their timeout.
    for (const p of projects) {
      const uid = `supabase-${p.ref}`
      try {
        await plugin.send(await collectProject(p, cfg), uid)
      } catch (e: any) {
        await plugin.send(
          { kind: "supabase", ref: p.ref, name: p.name || p.ref, reachable: false, error: String(e?.message || e).slice(0, 200), timestamp: Date.now() },
          uid,
        )
      }
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as SupabaseConfig)?.refreshInterval || 60000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "supabase",
    "supabase",
    "Supabase cloud project monitor (project status, service health, disk, connections)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createSupabasePlugin
