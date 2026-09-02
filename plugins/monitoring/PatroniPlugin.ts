import { hostname } from "node:os"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// Patroni monitor. Runs on a Patroni node and reads its local REST API, which is
// the only thing on the box that authoritatively knows who the leader is.
//
// Two endpoints, and the split between them matters:
//
//   GET /patroni  — THIS node's own view of itself: role, state, timeline, its
//                   own WAL position. Self-reported, so "I am the leader" is a
//                   first-hand claim and needs no name-to-host guessing on the
//                   server. That is what sets clusters.leader_system_id.
//   GET /cluster  — every member, with role/state/lag, as this node sees it via
//                   the DCS. Gives a follower a full picture of the cluster even
//                   while the leader's own agent is dead, which is exactly the
//                   moment the picture is worth having.
//
// Both are unauthenticated GETs by default (Patroni only protects the unsafe
// verbs), so this needs no credentials. Set username/password if the node runs
// with `restapi.authentication` covering reads.
//
// Why this exists at all: daemonitor could already see that a follow-the-leader
// service was running on exactly one host, but not whether it was the RIGHT
// host. Patroni moves the leader on its own schedule, and a singleton pinned to
// the old leader is a service running in the wrong place while looking perfectly
// healthy. Placement 'leader' is unenforceable without this.
//
// Severity is decided server-side (clientstate/update.put.ts), as with every
// other plugin: this one reports facts.

interface PatroniConfig {
  /** Base URL of the local Patroni REST API. */
  url?: string
  /** Optional basic auth, when restapi.authentication covers GETs. */
  username?: string
  password?: string
  /** Replication lag thresholds in BYTES, evaluated server-side. */
  lagWarnBytes?: number
  lagCritBytes?: number
  requestTimeout?: number
  refreshInterval?: number
  uniqueId?: string
  name?: string
}

interface PatroniMember {
  name: string
  role: string
  state: string
  host?: string
  port?: number
  apiUrl?: string
  timeline?: number
  /** Bytes behind the leader. Absent on the leader itself. */
  lagBytes?: number | null
}

const DEFAULTS = {
  url: "http://localhost:8008",
  lagWarnBytes: 32 * 1024 * 1024,   // 32MB: a busy node catching up
  lagCritBytes: 256 * 1024 * 1024,  // 256MB: not keeping up at all
  requestTimeout: 5000,
}

/**
 * Roles Patroni reports for a member that is holding the primary. `master` is
 * the pre-3.0 spelling and still shows up on older clusters; `standby_leader` is
 * the leader of a standby cluster, which is a primary as far as placement is
 * concerned even though it is replicating from elsewhere.
 */
const LEADER_ROLES = new Set(["leader", "master", "primary", "standby_leader"])

export function isLeaderRole(role: string | undefined): boolean {
  return LEADER_ROLES.has(String(role || "").toLowerCase())
}

async function getJson(url: string, cfg: PatroniConfig): Promise<any> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (cfg.username) {
    const raw = `${cfg.username}:${cfg.password ?? ""}`
    headers.Authorization = `Basic ${Buffer.from(raw).toString("base64")}`
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(cfg.requestTimeout ?? DEFAULTS.requestTimeout),
  })
  // Patroni answers /patroni with 503 on a node that is up but not healthy (a
  // replica that has lost its leader, a node in maintenance). The BODY is still
  // the node's state, and that state is the whole reason to ask, so read it
  // rather than treating the status code as a failure.
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`non-JSON response from ${url} (HTTP ${res.status})`)
  }
  if (!body && !res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  return body
}

/**
 * Bytes this member is behind the leader.
 *
 * /cluster reports `lag` per member and it is already in bytes, but it comes
 * back as the string "unknown" on a member the DCS cannot currently see. That
 * must stay distinct from 0: "unknown" means no information, and coercing it to
 * zero reports a node nobody can reach as perfectly caught up.
 */
function lagOf(member: any): number | null {
  const raw = member?.lag
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function normaliseMembers(cluster: any): PatroniMember[] {
  const list: any[] = Array.isArray(cluster?.members) ? cluster.members : []
  return list.map((m) => ({
    name: String(m?.name ?? "unknown"),
    role: String(m?.role ?? "unknown").toLowerCase(),
    state: String(m?.state ?? "unknown").toLowerCase(),
    host: m?.host ?? undefined,
    port: typeof m?.port === "number" ? m.port : undefined,
    apiUrl: m?.api_url ?? undefined,
    timeline: typeof m?.timeline === "number" ? m.timeline : undefined,
    lagBytes: lagOf(m),
  }))
}

export async function collectPatroni(cfg: PatroniConfig): Promise<any> {
  const base = String(cfg.url || DEFAULTS.url).replace(/\/+$/, "")

  // Ask for both, and do not let one failure hide the other. A node whose own
  // /patroni is 503-ing can still return a perfectly good /cluster, and that is
  // the reading that says whether the cluster as a whole has a leader.
  const [selfRes, clusterRes] = await Promise.allSettled([
    getJson(`${base}/patroni`, cfg),
    getJson(`${base}/cluster`, cfg),
  ])
  if (selfRes.status === "rejected" && clusterRes.status === "rejected") {
    throw new Error(String((selfRes.reason as Error)?.message || selfRes.reason))
  }
  const self = selfRes.status === "fulfilled" ? selfRes.value : null
  const cluster = clusterRes.status === "fulfilled" ? clusterRes.value : null

  const members = normaliseMembers(cluster)
  const scope = self?.patroni?.scope || cluster?.scope || undefined
  // Patroni's member name defaults to the hostname but is configurable, and the
  // server matches leader-by-name against it, so report what Patroni calls this
  // node rather than what the OS does.
  const member = self?.patroni?.name || self?.name || hostname()

  const selfRole = String(self?.role ?? "unknown").toLowerCase()
  const leaderMember = members.find((m) => isLeaderRole(m.role))
  const selfMember = members.find((m) => m.name === member)

  return {
    kind: "patroni",
    name: scope || "patroni",
    scope,
    member,
    reachable: true,
    // Self-reported role. The server trusts this over any name matching: a node
    // saying "I am the leader" identifies the leader's SYSTEM exactly, with no
    // guessing about which host a Patroni member name belongs to.
    role: selfRole,
    isLeader: isLeaderRole(selfRole),
    state: String(self?.state ?? "unknown").toLowerCase(),
    timeline: self?.timeline ?? selfMember?.timeline ?? null,
    serverVersion: self?.server_version ?? null,
    patroniVersion: self?.patroni?.version ?? null,
    // A cluster with no leader is either mid-election (seconds) or stuck
    // (forever). The server applies a grace window rather than paging on the gap.
    leader: leaderMember?.name ?? null,
    hasLeader: !!leaderMember,
    // Patroni sets this while the DCS lock is not held by anyone.
    clusterUnlocked: self?.cluster_unlocked === true,
    // Maintenance mode: failover is disabled, so a dead leader will NOT be
    // replaced. Worth surfacing because everything else looks normal.
    paused: self?.pause === true,
    pendingRestart: self?.pending_restart === true,
    lagBytes: selfMember?.lagBytes ?? null,
    lagWarnBytes: cfg.lagWarnBytes ?? DEFAULTS.lagWarnBytes,
    lagCritBytes: cfg.lagCritBytes ?? DEFAULTS.lagCritBytes,
    members,
    memberCount: members.length,
    runningCount: members.filter((m) => m.state === "running" || m.state === "streaming").length,
    // Set when /patroni answered but /cluster did not, or vice versa: the report
    // is partial and the server should not read a missing leader as no leader.
    partial: !self || !cluster,
    timestamp: Date.now(),
  }
}

export function createPatroniPlugin() {
  let refreshTimer: any = null

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as PatroniConfig
    const uid = cfg.uniqueId || "patroni"
    try {
      await plugin.send(await collectPatroni(cfg), uid)
    } catch (e: any) {
      // Report the failure rather than going quiet. Silence from this plugin is
      // indistinguishable from the agent being dead, and "Patroni's API is not
      // answering on this node" is itself a finding worth an alert.
      await plugin.send(
        {
          kind: "patroni",
          name: "patroni",
          member: hostname(),
          reachable: false,
          error: String(e?.message || e).slice(0, 200),
          timestamp: Date.now(),
        },
        uid,
      )
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    // 30s by default rather than the usual 60s: this is the input to leader
    // placement, so the window in which daemonitor believes the old leader is
    // still the leader is bounded by this interval.
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as PatroniConfig)?.refreshInterval || 30000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "patroni",
    "patroni",
    "Patroni HA Postgres monitor (leader identity, member roles, replication lag)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createPatroniPlugin
