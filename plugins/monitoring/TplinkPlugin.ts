import crypto from "node:crypto"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// TP-Link range extender / AP monitor (RE505X and siblings running TP-Link's
// LuCI-derived firmware).
//
// These devices expose NO SNMP — their firmware is a locked-down OpenWrt fork
// with no snmpd and no way to add one. But their web UI is backed by a JSON API
// that carries better signals than SNMP would:
//
//   internet_status  the UPLINK. An extender that loses its backhaul still
//                    answers ping perfectly while serving nobody — the failure
//                    a reachability check can never catch.
//   radios           2.4/5GHz enabled state (silently-off radio = no coverage)
//   wirelessGrid     connected clients (name, MAC, band)
//   firmware         version/model, for drift across a fleet of them
//
// Auth is TP-Link's RSA handshake: read a 1024-bit pubkey from the login form,
// PKCS#1 v1.5 encrypt the password, POST it, and keep the returned stok +
// sysauth cookie. Sessions expire, so a 403/timeout re-logs in on the next pass.

interface TplinkDevice {
  name: string
  ip: string
  password: string
  uniqueId?: string
}

interface TplinkConfig {
  devices?: TplinkDevice[]
  refreshInterval?: number
  timeout?: number
}

interface Session { stok: string; sysauth: string }

// Live sessions per device IP — re-used across polls, rebuilt when they lapse.
const sessions: Record<string, Session> = {}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
}

const b64u = (hex: string) =>
  Buffer.from(hex, "hex").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

function headers(ip: string, page: string, cookie?: string): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: `http://${ip}/webpages/${page}`,
    "X-Requested-With": "XMLHttpRequest",
    ...(cookie ? { Cookie: `sysauth=${cookie}` } : {}),
  }
}

async function post(url: string, hdrs: Record<string, string>, body: string, timeout: number): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: hdrs, body, signal: AbortSignal.timeout(timeout) })
  return await res.json()
}

/** TP-Link RSA login → { stok, sysauth }. Throws on bad credentials. */
async function login(d: TplinkDevice, timeout: number): Promise<Session> {
  const base = `http://${d.ip}/cgi-bin/luci/;stok=`
  const keyRes = await post(`${base}/login?form=login`, headers(d.ip, "login.html"), "operation=read", timeout)
  const pair = keyRes?.data?.password
  if (!Array.isArray(pair) || pair.length < 2) throw new Error("no RSA key from login form")

  const pub = crypto.createPublicKey({
    key: { kty: "RSA", n: b64u(pair[0]), e: b64u(pair[1]) } as any,
    format: "jwk",
  })
  const enc = crypto
    .publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(d.password))
    .toString("hex")

  const res = await fetch(`${base}/login?form=login`, {
    method: "POST",
    headers: headers(d.ip, "login.html"),
    body: `operation=login&password=${enc}`,
    signal: AbortSignal.timeout(timeout),
  })
  const setCookie = res.headers.get("set-cookie") || ""
  const body: any = await res.json()
  const stok = body?.data?.stok
  const sysauth = (setCookie.match(/sysauth=([^;]+)/) || [])[1]
  if (!stok || !sysauth) {
    throw new Error(body?.errorcode === "login failed" ? "login failed (bad password?)" : "login rejected")
  }
  return { stok, sysauth }
}

/** Authenticated read, re-logging in once if the session has lapsed. */
async function read(d: TplinkDevice, endpoint: string, timeout: number): Promise<any> {
  const call = async (s: Session) =>
    post(
      `http://${d.ip}/cgi-bin/luci/;stok=${s.stok}/${endpoint}`,
      headers(d.ip, "index.html", s.sysauth),
      "operation=read",
      timeout,
    )

  let s = sessions[d.ip]
  if (s) {
    try {
      const out = await call(s)
      if (out?.success) return out.data
    } catch {
      /* fall through to re-login */
    }
  }
  s = await login(d, timeout)
  sessions[d.ip] = s
  const out = await call(s)
  if (!out?.success) throw new Error(out?.errorcode || "read failed")
  return out.data
}

async function collect(d: TplinkDevice, timeout: number): Promise<any> {
  try {
    const status = await read(d, "admin/status?form=ap_status", timeout)
    // Firmware is static — nice for drift, but never fail the poll over it.
    let fw: any = {}
    try {
      fw = (await read(d, "admin/firmware?form=upgrade", timeout)) || {}
    } catch {
      /* non-fatal */
    }

    const grid = status?.wirelessGrid
    const clients = Array.isArray(grid)
      ? grid.map((c: any) => ({
          name: c.name || c.hostname || "device",
          mac: c.mac || "",
          band: c.type || "",
        }))
      : []

    const radio2g = String(status?.wireless_2g_enable ?? "") === "on"
    const radio5g = String(status?.wireless_5g_enable ?? "") === "on"

    return {
      name: d.name,
      ip: d.ip,
      kind: "extender",
      reachable: true,
      // The uplink — an extender with this down still pings but serves nobody.
      internetStatus: status?.internet_status ?? undefined,
      uplinkUp: status?.internet_status === "connected",
      phyconn: status?.phyconn ?? undefined,
      radio2g,
      radio5g,
      clientCount: typeof status?.wirelessCount === "number" ? status.wirelessCount : clients.length,
      clients,
      model: fw.model || undefined,
      hardwareVersion: fw.hardware_version || undefined,
      firmware: fw.firmware_version || undefined,
    }
  } catch (e: any) {
    delete sessions[d.ip] // force a fresh login next pass
    return {
      name: d.name,
      ip: d.ip,
      kind: "extender",
      reachable: false,
      error: String(e?.message || e).slice(0, 160),
    }
  }
}

export function createTplinkPlugin() {
  let refreshTimer: any = null

  const devicesOf = (plugin: MonitoringPluginBase): TplinkDevice[] => {
    const cfg = (plugin.config || {}) as TplinkConfig
    return (Array.isArray(cfg.devices) ? cfg.devices : []).filter((d) => d?.ip && d?.password)
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as TplinkConfig
    const timeout = cfg.timeout || 8000
    await Promise.all(
      devicesOf(plugin).map(async (d) => {
        const uid = d.uniqueId || `tplink-${slug(d.name || d.ip)}`
        try {
          await plugin.send(await collect(d, timeout), uid)
        } catch (e: any) {
          await plugin.send(
            { name: d.name, ip: d.ip, kind: "extender", reachable: false, error: String(e?.message || e).slice(0, 160) },
            uid,
          )
        }
      }),
    )
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as TplinkConfig)?.refreshInterval || 120000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "tplink",
    "tplink",
    "TP-Link extender/AP monitor (uplink, radios, clients, firmware)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createTplinkPlugin
