import * as https from "node:https"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// Disks, pools and volumes on a Synology NAS, read through the DSM web API.
//
// Reports as type "snmp" with kind "qnap", the payload the server already folds
// into the `dev-<ip>` device row and draws as a NAS card, alerts included. Those
// names are the wire format, not a claim about how the data was read.
//
// SYNO.Storage.CGI.Storage is the call DSM's own Storage Manager makes, and
// Synology doesn't document it, so a DSM update can change it. Anything other
// than "normal" counts as bad, so a status this code has never seen alerts.
//
// ponytail: logs in and out on every pass, so no session to keep alive or renew.
// Keep a session if the login shows up as noise in DSM's connection log.

interface SynologyConfig {
  name?: string
  url?: string // https://<nas>:5001
  account?: string
  password?: string
  insecure?: boolean // DSM's default certificate is self-signed
  refreshInterval?: number
  requestTimeout?: number
  volumeWarnPct?: number
  tempWarnC?: number
  // Mounts that must exist, e.g. "usbshare1". A USB disk that drops off the bus
  // simply vanishes from the API, so nothing else would report it.
  expectedVolumes?: string[]
}

type Call = (api: string, method: string, version: number, extra?: Record<string, string>) => Promise<any>

const REAUTH_AFTER_MS = 3_600_000

const AUTH_ERRORS: Record<number, string> = {
  400: "wrong account or password",
  401: "account disabled",
  402: "account may not use this service",
  403: "account has 2FA on, which an agent can't answer",
  404: "2FA code rejected",
  407: "this host is blocked by DSM's auto block",
}

/** A login DSM refused. Retrying every pass would trip its auto block. */
export const authErrorText = (code: unknown): string | undefined => AUTH_ERRORS[Number(code)]

const apiErrorText = (api: string, code: unknown) =>
  Number(code) === 105 ? `${api}: this account lacks permission, it may need to be an administrator` : `${api}: DSM error ${code}`

// "SID not found". DSM drops about 1% of sessions it has just opened, on the
// first call after a successful login. Why isn't known; a new login works.
const SESSION_LOST = 119

/** Run a whole login-to-logout pass, again if DSM lost the session. Once only. */
export async function retryLostSession<T>(pass: () => Promise<T>): Promise<T> {
  try {
    return await pass()
  } catch (e: any) {
    if (e?.dsmCode !== SESSION_LOST) throw e
    return pass()
  }
}

function post(url: string, form: Record<string, string>, cfg: SynologyConfig): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString()
    const u = new URL("/webapi/entry.cgi", url)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
        rejectUnauthorized: !cfg.insecure,
      },
      (res) => {
        let text = ""
        res.on("data", (c) => { text += c })
        res.on("end", () => {
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`DSM answered HTTP ${res.statusCode} with something other than JSON`))
          }
        })
      },
    )
    req.on("error", reject)
    req.setTimeout(cfg.requestTimeout || 20000, () => req.destroy(new Error("DSM request timed out")))
    req.end(body)
  })
}

/** Turn DSM's answers into the NAS card's payload. Exported for the check. */
export function summarise(storage: any, usb: any, system: any, util: any, cfg: SynologyConfig = {}) {
  const tempWarn = cfg.tempWarnC ?? 70
  const volWarn = cfg.volumeWarnPct ?? 85
  const problems: string[] = []
  const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0)

  const disks: any[] = (storage?.disks || []).map((d: any, i: number) => ({
    slot: i + 1,
    descr: d.name || d.device,
    model: d.model,
    tempC: typeof d.temp === "number" ? d.temp : undefined,
    status: d.status === "normal" ? 0 : 1,
    smart: Number(d.unc) > 0 ? `${d.unc} uncorrectable` : d.smart_status,
  }))

  const volumes: any[] = (storage?.volumes || []).map((v: any) => {
    const total = Number(v.size?.total) || 0
    const used = Number(v.size?.used) || 0
    if (v.status !== "normal") problems.push(`${v.vol_path} ${v.status}`)
    return { mount: v.vol_path, totalGB: Math.round(total / 1e9), usedGB: Math.round(used / 1e9), pct: pct(used, total) }
  })

  for (const p of storage?.storagePools || []) {
    if (p.status !== "normal") problems.push(`pool ${p.device_type || p.id} ${p.status}`)
  }

  // DSM states USB sizes in MiB. Its USB disks report no SMART or temperature here.
  for (const dev of usb?.devices || []) {
    disks.push({ slot: disks.length + 1, descr: `USB ${dev.dev_id}`, model: dev.product_name, status: dev.status === "normal" ? 0 : 1 })
    for (const p of dev.partitions || []) {
      const total = Number(p.total_size_mb) || 0
      const used = Number(p.used_size_mb) || 0
      if (p.status !== "normal") problems.push(`${p.share_name} ${p.status}`)
      volumes.push({ mount: p.share_name, totalGB: Math.round((total * 1.048576) / 1000), usedGB: Math.round((used * 1.048576) / 1000), pct: pct(used, total) })
    }
  }

  const mounts = volumes.map((v) => String(v.mount).split("/").pop())
  for (const want of cfg.expectedVolumes || []) {
    if (!mounts.includes(want)) problems.push(`${want} missing`)
  }
  if (!disks.length) problems.push("DSM listed no disks")
  if (system?.temperature_warning === true) problems.push("DSM reports overheating")

  const badDisks = disks.filter((d) => d.status !== 0 || (d.smart && d.smart !== "normal") || (d.tempC != null && d.tempC >= tempWarn))
  const cpu = util?.cpu
  const mem = util?.memory
  return {
    kind: "qnap",
    reachable: true,
    model: system?.model,
    cpuPct: cpu ? (Number(cpu.user_load) || 0) + (Number(cpu.system_load) || 0) + (Number(cpu.other_load) || 0) : undefined,
    sysTempC: typeof system?.sys_temp === "number" ? system.sys_temp : undefined,
    memPct: typeof mem?.real_usage === "number" ? mem.real_usage : undefined,
    memTotalMB: mem?.total_real ? Math.round(mem.total_real / 1024) : undefined,
    disks,
    diskCount: disks.length,
    badDisks: badDisks.map(({ slot, descr, model, status, smart, tempC }) => ({ slot, descr, model, status, smart, tempC })),
    volumes,
    fullVolumes: volumes.filter((v) => v.pct >= volWarn),
    tempWarnC: tempWarn,
    volumeWarnPct: volWarn,
    ...(problems.length ? { error: problems.join(", ").slice(0, 120) } : {}),
  }
}

async function collect(call: Call, cfg: SynologyConfig) {
  const storage = await call("SYNO.Storage.CGI.Storage", "load_info", 1)
  if (!storage.success) throw Object.assign(new Error(apiErrorText("storage", storage.error?.code)), { dsmCode: storage.error?.code })
  // Extras: the card is still worth drawing without them.
  const [usb, system, util] = await Promise.all([
    call("SYNO.Core.ExternalDevice.Storage.USB", "list", 1, { additional: '["all"]' }).catch(() => null),
    call("SYNO.Core.System", "info", 3).catch(() => null),
    call("SYNO.Core.System.Utilization", "get", 1).catch(() => null),
  ])
  return summarise(storage.data, usb?.success ? usb.data : null, system?.success ? system.data : null, util?.success ? util.data : null, cfg)
}

export function createSynologyPlugin() {
  let refreshTimer: any = null
  let lockedUntil = 0
  let lockedReason = ""

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as SynologyConfig
    const name = cfg.name || "synology"
    let ip = ""
    const report = (body: any) => plugin.send({ name, ip, ...body, timestamp: Date.now() }, `synology-${ip}`)
    try {
      const u = new URL(String(cfg.url))
      ip = u.hostname
      if (u.protocol !== "https:") throw new Error("url must be https, the password travels in the request")
      if (!cfg.account || !cfg.password) throw new Error("config needs account and password")
      if (Date.now() < lockedUntil) throw new Error(lockedReason)

      await report(await retryLostSession(async () => {
        const login = await post(cfg.url!, { api: "SYNO.API.Auth", version: "6", method: "login", account: cfg.account!, passwd: cfg.password!, format: "sid" }, cfg)
        if (!login.success) {
          const code = login.error?.code
          const refused = authErrorText(code)
          if (refused) {
            lockedUntil = Date.now() + REAUTH_AFTER_MS
            lockedReason = `login refused: ${refused}. Next try within the hour, or restart the agent`
            throw new Error(lockedReason)
          }
          throw new Error(`login failed: DSM error ${code}`)
        }

        const sid = String(login.data?.sid)
        const call: Call = (api, method, version, extra = {}) =>
          post(cfg.url!, { api, method, version: String(version), _sid: sid, ...extra }, cfg)
        try {
          return await collect(call, cfg)
        } finally {
          await call("SYNO.API.Auth", "logout", 6).catch(() => {})
        }
      }))
    } catch (e: any) {
      await report({ kind: "qnap", reachable: false, error: String(e?.message || e).slice(0, 120) })
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as SynologyConfig)?.refreshInterval || 300000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  const plugin = createMonitoringPlugin(
    "synology",
    "snmp",
    "Synology NAS disks, pools and volumes through the DSM web API",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
  // `name` is the x-type sent to the server, and PluginManager picks plugins from
  // the config list by getName(). Without this, listing "synology" runs nothing.
  plugin.getName = () => "synology"
  return plugin
}

export default createSynologyPlugin
