import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

const execFileAsync = promisify(execFile)

// Sign-ups and logins for the apps behind one agent. Each source reports as its
// own service, so an app's activity joins that app's group like any other member.
//
// Two kinds of source:
//   postgres  a Supabase database on this host, read through `docker exec psql`.
//             Needs no credentials and works on a replica. Counts come from
//             auth.audit_log_entries.
//   supabase  a cloud project, read through GoTrue's admin API with the service
//             key. There is no audit log to read from there, only each user's
//             last sign-in, so `logins` counts people, and `loginsArePeople` says so.
//
// Windows are counted fresh on every report, so a restart can't lose or double
// anything. Emails are masked here, before they leave the host: a group share
// makes the whole service row readable.

interface ActivitySource {
  name: string
  kind?: "postgres" | "supabase"
  uniqueId?: string
  // postgres
  database?: string
  container?: string
  // supabase
  url?: string
  serviceKey?: string
}

interface AppActivityConfig {
  sources?: ActivitySource[]
  refreshInterval?: number
  requestTimeout?: number
}

interface ActivityEvent {
  at: string
  action: "signup" | "login"
  who: string
  provider?: string
}

const DAY_MS = 86_400_000
const RECENT_LIMIT = 10
const MAX_USER_PAGES = 20
const USER_PAGE_SIZE = 1000

export function maskEmail(email: unknown): string {
  const s = String(email ?? "")
  const at = s.indexOf("@")
  if (at < 1) return "unknown"
  return `${s[0]}***${s.slice(at)}`
}

// One row per person, action and minute: a Google sign-in writes two audit lines
// a moment apart. An account made through the admin API names service_role as the
// actor and the new user in traits.user_id, as in admin_auth_events().
export const AUDIT_SQL = `
with e as (
  select distinct on (person, action, date_trunc('minute', created_at))
         created_at as at, action, who, provider
  from (
    select created_at,
           payload->>'action' as action,
           coalesce(payload->'traits'->>'user_id', payload->>'actor_id') as person,
           coalesce(payload->'traits'->>'user_email', payload->>'actor_username') as who,
           coalesce(payload->'traits'->>'provider', payload->'traits'->>'provider_type') as provider
    from auth.audit_log_entries
    where created_at >= now() - interval '30 days'
      and payload->>'action' in ('user_signedup', 'login')
  ) raw
  order by person, action, date_trunc('minute', created_at), created_at
)
select json_build_object(
  'users', (select count(*) from auth.users where deleted_at is null),
  'events', coalesce((select json_agg(e) from e), '[]'::json)
)`

const windows = (times: number[], now: number) => ({
  d1: times.filter((t) => t >= now - DAY_MS).length,
  d7: times.filter((t) => t >= now - 7 * DAY_MS).length,
  d30: times.filter((t) => t >= now - 30 * DAY_MS).length,
})

const newestFirst = (events: ActivityEvent[]) =>
  [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, RECENT_LIMIT)

/** Turn audit rows into the report. Exported for the check. */
export function summariseAudit(users: number, rows: any[], now = Date.now()) {
  const events: ActivityEvent[] = rows.map((r) => ({
    at: new Date(r.at).toISOString(),
    action: r.action === "user_signedup" ? "signup" : "login",
    who: maskEmail(r.who),
    ...(r.provider ? { provider: String(r.provider) } : {}),
  }))
  const times = (action: string) => events.filter((e) => e.action === action).map((e) => Date.parse(e.at))
  return {
    users,
    signups: windows(times("signup"), now),
    logins: windows(times("login"), now),
    loginsArePeople: false,
    recent: newestFirst(events),
  }
}

/** Turn GoTrue admin users into the report. Exported for the check. */
export function summariseUsers(list: any[], now = Date.now()) {
  const stamp = (v: unknown) => {
    const t = Date.parse(String(v ?? ""))
    return Number.isFinite(t) ? t : null
  }
  const events: ActivityEvent[] = []
  const signups: number[] = []
  const logins: number[] = []
  for (const u of list) {
    const who = maskEmail(u?.email)
    const provider = u?.app_metadata?.provider ? String(u.app_metadata.provider) : undefined
    const created = stamp(u?.created_at)
    const seen = stamp(u?.last_sign_in_at)
    if (created != null && created >= now - 30 * DAY_MS) {
      signups.push(created)
      events.push({ at: new Date(created).toISOString(), action: "signup", who, ...(provider ? { provider } : {}) })
    }
    if (seen != null && seen >= now - 30 * DAY_MS) {
      logins.push(seen)
      events.push({ at: new Date(seen).toISOString(), action: "login", who, ...(provider ? { provider } : {}) })
    }
  }
  return {
    users: list.length,
    signups: windows(signups, now),
    logins: windows(logins, now),
    loginsArePeople: true,
    recent: newestFirst(events),
  }
}

async function collectPostgres(src: ActivitySource, timeout: number) {
  if (!src.database) throw new Error("source has no database")
  // ponytail: reads through one local container, so this agent's host going down
  // silences every source. Move to HAProxy with a read-only role if that bites.
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", src.container || "supacluster-patroni-1", "psql", "-U", "postgres", "-d", src.database, "-tAc", AUDIT_SQL],
    { timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout)
  return summariseAudit(Number(parsed.users) || 0, parsed.events || [])
}

async function collectSupabase(src: ActivitySource, timeout: number) {
  if (!src.url || !src.serviceKey) throw new Error("source needs url and serviceKey")
  const base = src.url.replace(/\/+$/, "")
  const list: any[] = []
  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const res = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=${USER_PAGE_SIZE}`, {
      headers: { apikey: src.serviceKey, Authorization: `Bearer ${src.serviceKey}` },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) throw new Error(`admin users HTTP ${res.status}`)
    const users = ((await res.json()) as any)?.users || []
    list.push(...users)
    if (users.length < USER_PAGE_SIZE) break
  }
  return summariseUsers(list)
}

export function sourceUid(src: ActivitySource): string {
  return src.uniqueId || `activity-${src.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
}

export function createAppActivityPlugin() {
  let refreshTimer: any = null

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as AppActivityConfig
    const timeout = cfg.requestTimeout || 20000
    for (const src of cfg.sources || []) {
      const uid = sourceUid(src)
      const head = { kind: "appactivity", name: src.name, source: src.kind || "postgres" }
      try {
        const body = src.kind === "supabase" ? await collectSupabase(src, timeout) : await collectPostgres(src, timeout)
        await plugin.send({ ...head, reachable: true, ...body, timestamp: Date.now() }, uid)
      } catch (e: any) {
        await plugin.send({ ...head, reachable: false, error: String(e?.message || e).slice(0, 200), timestamp: Date.now() }, uid)
      }
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as AppActivityConfig)?.refreshInterval || 300000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "appactivity",
    "appactivity",
    "Sign-ups and logins for apps on Supabase, self-hosted or cloud",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createAppActivityPlugin
