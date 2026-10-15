import { createHash } from "node:crypto"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// TP-Link Omada "Easy Managed" switches (the ES line, e.g. ES206X-M2) have no
// SNMP, and without an Omada controller their only interface is the web UI.
// That UI is a single-page app over a small JSON API, which this plugin reads:
//
//   POST /login/status   { login_user, login_pwd: MD5(password) upper-case hex }
//                        -> result.token, sent as the Authorization header
//   GET  /system_summary/system_information_status   model, firmware, MAC, serial
//   GET  /switching/port_settings_status             per-port enable, link, speed
//   GET  /traffic_summary/traffic_summary_port_status per-port byte/packet counters
//   GET  /loop_detection/loop_detection_status       per-port loop state
//   POST /show_up/logout_status
//
// Every response is { error_code, result }; 7405/7414 mean "not logged in".
// Mapped from the UI's own code and checked against a live ES206X-M2.
//
// The report has the same shape as the snmp plugin's switch report, so the
// server folds it into the same `device` (by IP) as a netscan ping, and the
// dashboard draws it with the existing switch card.
//
// The switch counts failed logins. A refused login is not retried until
// loginBackoffMs has passed, so a wrong password can't lock the account out.

export interface SwitchTarget {
  host: string
  name?: string
  username: string
  password: string
  // Ports that must have link. One going down is an error; any other port
  // going down is only shown on the card, since ports come and go.
  uplinkPorts?: number[]
}

export interface TplinkSwitchConfig {
  switches?: SwitchTarget[]
  refreshInterval?: number // ms, default 60000
  loginBackoffMs?: number // after a refused login, default 30 min
  timeoutMs?: number // per request, default 8000
}

export interface PortReport {
  name: string
  up: boolean
  adminUp: boolean
  speed?: string
  duplex?: string
  inBps?: number
  outBps?: number
  rxBytes?: number
  txBytes?: number
  loop?: "normal" | "blocked" | "loop"
}

const HEADERS = { "Content-Type": "application/json;charset=utf-8", "X-Requested-With": "XMLHttpRequest", SourceType: "switch_web" }
const LOOP: Record<string, PortReport["loop"]> = { "0": "normal", "1": "blocked", "2": "loop" }

export const md5Upper = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase()

/** Build the report from the raw API results. Pure, so the check can drive it. */
export function buildReport(
  target: { host: string; name?: string; uplinkPorts?: number[] },
  raw: { info: any; ports: any; traffic: any; loops: any },
  rates: Map<number, { inBps?: number; outBps?: number }>,
) {
  const info = raw.info || {}
  const trafficById = new Map<number, any>((raw.traffic?.port_list || []).map((p: any) => [p.port_id, p]))
  const loopById = new Map<number, any>((raw.loops?.port_list || []).map((p: any) => [p.port_id, p]))
  const interfaces: PortReport[] = (raw.ports?.port_list || []).map((p: any) => {
    const speed = String(p.port_speed_actual || "")
    const up = !!speed && speed !== "Link Down"
    const t = trafficById.get(p.port_id)
    const r = rates.get(p.port_id) || {}
    return {
      name: `port ${p.port_id}`,
      up,
      adminUp: p.port_state_cfg !== "0",
      ...(up ? { speed, duplex: p.port_duplex_actual } : {}),
      ...(t ? { rxBytes: t.rx_bytes, txBytes: t.tx_bytes } : {}),
      ...(r.inBps != null ? { inBps: r.inBps, outBps: r.outBps } : {}),
      loop: LOOP[String(loopById.get(p.port_id)?.port_state ?? "0")] || "normal",
    }
  })
  const portIds: number[] = (raw.ports?.port_list || []).map((p: any) => p.port_id)
  const downUplinks = (target.uplinkPorts || []).filter((id) => {
    const i = portIds.indexOf(id)
    return i < 0 || !interfaces[i].up
  })
  return {
    ip: target.host,
    name: target.name || info.des || target.host,
    kind: "switch",
    model: info.hw_ver || info.des,
    serial: info.serial_number,
    mac: info.sys_mac_addr,
    firmware: info.fw_ver,
    sysDescr: [info.hw_ver || info.des, info.fw_ver && `firmware ${info.fw_ver}`].filter(Boolean).join(", "),
    reachable: true,
    portsUp: interfaces.filter((i) => i.up).length,
    portsTotal: interfaces.length,
    interfaces,
    loops: interfaces.filter((i) => i.loop === "loop").map((i) => i.name),
    blocked: interfaces.filter((i) => i.loop === "blocked").map((i) => i.name),
    // Every configured uplink, so the dashboard can mark it while it's healthy too.
    uplinks: (target.uplinkPorts || []).map((id) => `port ${id}`),
    downUplinks: downUplinks.map((id) => `port ${id}`),
  }
}

/** Byte rates from two counter readings. A counter that went backwards (reboot, clear) gives no rate. */
export function ratesBetween(
  prev: { at: number; ports: Map<number, { rx: number; tx: number }> } | undefined,
  now: { at: number; ports: Map<number, { rx: number; tx: number }> },
): Map<number, { inBps?: number; outBps?: number }> {
  const out = new Map<number, { inBps?: number; outBps?: number }>()
  if (!prev) return out
  const dt = (now.at - prev.at) / 1000
  if (dt <= 0) return out
  for (const [id, c] of now.ports) {
    const p = prev.ports.get(id)
    if (!p || c.rx < p.rx || c.tx < p.tx) continue
    out.set(id, { inBps: Math.round((c.rx - p.rx) / dt), outBps: Math.round((c.tx - p.tx) / dt) })
  }
  return out
}

export class LoginRefused extends Error {}

async function call(host: string, path: string, opts: { token?: string; body?: unknown; timeoutMs: number }) {
  const res = await fetch(`http://${host}${path}`, {
    method: opts.body !== undefined ? "POST" : "GET",
    headers: opts.token ? { ...HEADERS, Authorization: opts.token } : HEADERS,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`)
  const json: any = await res.json()
  if (json?.error_code) throw Object.assign(new Error(`${path} error_code ${json.error_code}`), { code: json.error_code })
  return json?.result || {}
}

/** Per-switch memory across polls: last counters (for rates) and login backoff. */
export interface SwitchState {
  counters: Map<string, { at: number; ports: Map<number, { rx: number; tx: number }> }>
  refusedUntil: Map<string, number>
}
export const newSwitchState = (): SwitchState => ({ counters: new Map(), refusedUntil: new Map() })

/** Log in, read one switch, log out. Throws LoginRefused or a network error. */
export async function readSwitch(target: SwitchTarget, cfg: TplinkSwitchConfig, state: SwitchState) {
    const { counters, refusedUntil } = state
    const timeoutMs = cfg.timeoutMs || 8000
    const wait = refusedUntil.get(target.host)
    if (wait && Date.now() < wait) {
      throw new LoginRefused(`login refused earlier; not retrying until ${new Date(wait).toISOString()} so the switch doesn't lock the account`)
    }
    let login: any
    try {
      login = await call(target.host, "/login/status", { body: { login_user: target.username, login_pwd: md5Upper(target.password) }, timeoutMs })
    } catch (e: any) {
      if (e?.code) {
        refusedUntil.set(target.host, Date.now() + (cfg.loginBackoffMs || 30 * 60 * 1000))
        throw new LoginRefused(`login refused (error_code ${e.code}); check the username and password`)
      }
      throw e
    }
    refusedUntil.delete(target.host)
    const token = login.token
    try {
      const [info, ports, traffic, loops] = await Promise.all([
        call(target.host, "/system_summary/system_information_status", { token, timeoutMs }),
        call(target.host, "/switching/port_settings_status", { token, timeoutMs }),
        call(target.host, "/traffic_summary/traffic_summary_port_status", { token, timeoutMs }),
        call(target.host, "/loop_detection/loop_detection_status", { token, timeoutMs }).catch(() => ({})),
      ])
      const now = {
        at: Date.now(),
        ports: new Map<number, { rx: number; tx: number }>((traffic.port_list || []).map((p: any) => [p.port_id, { rx: Number(p.rx_bytes) || 0, tx: Number(p.tx_bytes) || 0 }])),
      }
      const rates = ratesBetween(counters.get(target.host), now)
      counters.set(target.host, now)
      return buildReport(target, { info, ports, traffic, loops }, rates)
    } finally {
      // Log out every time: these switches allow few admin sessions, and an
      // idle one held by the agent could lock someone out of the web UI.
      await call(target.host, "/show_up/logout_status", { token, body: {}, timeoutMs }).catch(() => {})
    }
}

export function createTplinkSwitchPlugin() {
  let refreshTimer: any = null
  const state = newSwitchState()

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as TplinkSwitchConfig
    const targets = (cfg.switches || []).filter((s) => s?.host && s.username && s.password)
    await Promise.all(targets.map(async (target) => {
      let report: Record<string, unknown>
      try {
        report = await readSwitch(target, cfg, state)
      } catch (e: any) {
        report = {
          ip: target.host,
          name: target.name || target.host,
          kind: "switch",
          reachable: e instanceof LoginRefused,
          error: String(e?.message || e).slice(0, 200),
        }
      }
      await plugin.send(report, `tplinkswitch-${target.host.replace(/[^0-9a-zA-Z]+/g, "-")}`)
    }))
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as TplinkSwitchConfig
    if (!(cfg.switches || []).length) console.warn("tplinkswitch: no switches configured")
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), cfg.refreshInterval || 60000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin("tplinkswitch", "tplinkswitch", "TP-Link Omada Easy Managed switch (web API)", async () => {}, monitorFn, refreshFn, teardownFn)
}

export default createTplinkSwitchPlugin
