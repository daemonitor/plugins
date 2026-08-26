import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { connect } from "node:net"
import { hostname } from "node:os"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"

// 3CX PhoneSystem monitor. Runs ON a 3CX appliance (Debian) and watches the
// signals that actually break a PBX, using only unprivileged, auth-free reads:
//   - every 3CX* systemd unit is active (a crashed CallFlow/SIP/Media server is
//     the real failure mode; `systemctl -o json` needs no root)
//   - the PBX version (dpkg)
//   - SIP (5060/5061) and the management console (443) are actually listening
//
// It deliberately avoids the 3CX management API — that needs a bearer token and
// per-appliance provisioning; service + port liveness catches an outage without
// any secret on the box. One client_state per instance, type "3cx".
//
// Two roles:
//   - "pbx" (default): the PhoneSystem — 3CX* services, SIP listeners (5060/5061),
//     management console (443).
//   - "sbc": a Session Border Controller — the single 3cxsbc service plus its
//     OUTBOUND tunnel to the PBX (an established TCP session to the PBX on 5090).
//     An SBC doesn't listen for SIP locally, so its health is "service up AND
//     tunnel to the PBX connected", not a listen-probe.
//
// Severity is decided server-side (clientstate/update.put.ts): any down service,
// a dead SIP port, or (SBC) a dropped tunnel → error; console down → warning.

const pexec = promisify(execFile)

type Role = "pbx" | "sbc"

interface ThreeCXInstance {
  name?: string          // display name (defaults to hostname)
  role?: Role            // "pbx" (default) or "sbc"
  host?: string          // where to probe ports (default 127.0.0.1 — runs on-box)
  unitGlob?: string      // systemd unit glob (default "3CX*", sbc: "3cxsbc*")
  versionPkg?: string    // dpkg package (default "3cxpbx", sbc: "3cxsbc")
  sipPorts?: number[]    // pbx: SIP listeners to probe (default [5060, 5061])
  consolePort?: number   // pbx: management console port (default 443)
  pbxTunnelPort?: number // tunnel port (default 5090): sbc dials OUT to it; pbx listens on it
  sbcs?: { name: string; peer?: string }[] // pbx: SBCs to watch by their inbound tunnel.
  // peer = the SBC's public/edge IP as seen by the PBX (its NAT address); omit to
  // just require ≥1 inbound tunnel. Reports each SBC connected/disconnected so a
  // dropped branch SBC is visible from the PBX — no agent on the SBC itself.
  systemctlBin?: string  // default "systemctl"
  uniqueId?: string      // client_state uid (default 3cx-<slug(name)>)
}

interface ThreeCXConfig extends ThreeCXInstance {
  instances?: ThreeCXInstance[] // omit → a single on-box instance from the top-level fields
  refreshInterval?: number
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
}

// TCP connect probe — a listening SIP/console port answers the handshake.
function portListening(host: string, port: number, timeout = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once("connect", () => finish(true))
    sock.once("timeout", () => finish(false))
    sock.once("error", () => finish(false))
  })
}

async function pbxVersion(pkg: string): Promise<string | undefined> {
  try {
    const { stdout } = await pexec("dpkg-query", ["-W", "-f=${Version}", pkg], { timeout: 6000 })
    const v = stdout.trim()
    return v || undefined
  } catch {
    return undefined
  }
}

// SBC tunnel: the SBC keeps an established outbound TCP session to the PBX on the
// tunnel port (5090). `ss -tn state established` needs no root and its absence is
// the real "SBC is cut off from the PBX" signal. Returns whether ≥1 such session
// exists and the PBX peer it points at.
async function tunnelStatus(port: number): Promise<{ up: boolean; peer?: string }> {
  try {
    const { stdout } = await pexec("ss", ["-tn", "state", "established"], { timeout: 6000 })
    const suffix = `:${port}`
    for (const line of stdout.split("\n")) {
      const cols = line.trim().split(/\s+/)
      const peer = cols[cols.length - 1] // "Peer Address:Port" is the last column
      if (peer && peer.endsWith(suffix)) {
        return { up: true, peer: peer.slice(0, -suffix.length) }
      }
    }
    return { up: false }
  } catch {
    return { up: false }
  }
}

// Inbound tunnels: on the PBX, each connected SBC (and any tunnelled client) holds
// an established session whose LOCAL port is the tunnel port (5090). Returns the
// set of distinct peer IPs — matching a configured SBC's edge IP tells us that SBC
// is still reaching the PBX, observed entirely from the PBX side.
async function inboundTunnelPeers(port: number): Promise<string[]> {
  try {
    const { stdout } = await pexec("ss", ["-tn", "state", "established"], { timeout: 6000 })
    const suffix = `:${port}`
    const peers = new Set<string>()
    for (const line of stdout.split("\n")) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 2) continue
      const local = cols[cols.length - 2]
      const peer = cols[cols.length - 1]
      if (!local || !local.endsWith(suffix)) continue // only sessions we LISTEN for on :port
      const ip = peer.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").replace(/^::ffff:/, "")
      if (ip) peers.add(ip)
    }
    return [...peers]
  } catch {
    return []
  }
}

async function collect3cx(inst: ThreeCXInstance): Promise<any> {
  const role: Role = inst.role === "sbc" ? "sbc" : "pbx"
  const name = inst.name || hostname()
  const host = inst.host || "127.0.0.1"
  const unitGlob = inst.unitGlob || (role === "sbc" ? "3cxsbc*" : "3CX*")
  const versionPkg = inst.versionPkg || (role === "sbc" ? "3cxsbc" : "3cxpbx")
  const sipPorts = inst.sipPorts && inst.sipPorts.length ? inst.sipPorts : [5060, 5061]
  const consolePort = inst.consolePort ?? 443
  const pbxTunnelPort = inst.pbxTunnelPort ?? 5090
  const systemctlBin = inst.systemctlBin || "systemctl"

  // --- systemd unit health (unprivileged JSON) ---
  let units: { unit: string; active: string; sub: string }[] = []
  let listErr: string | undefined
  try {
    const { stdout } = await pexec(
      systemctlBin,
      ["list-units", unitGlob, "--all", "--type=service", "--no-pager", "--no-legend", "-o", "json"],
      { timeout: 10000 },
    )
    const parsed = JSON.parse(stdout || "[]")
    units = (Array.isArray(parsed) ? parsed : []).map((u: any) => ({
      unit: String(u.unit || ""),
      active: String(u.active || ""),
      sub: String(u.sub || ""),
    }))
  } catch (e: any) {
    listErr = String(e?.message || e).slice(0, 160)
  }

  // A reachable 3CX box always has its service units. Zero units + an error
  // means we couldn't read systemd at all — report INCOMPLETE, not all-clear,
  // so a real outage isn't hidden behind a false green.
  if (!units.length) {
    return {
      kind: "3cx", role, name, host, reachable: !listErr,
      error: listErr ? `systemctl read failed — ${listErr}` : `no ${role === "sbc" ? "3cxsbc" : "3CX"} services found`,
    }
  }

  // A oneshot unit that has run and exited (e.g. 3CXFirewall) reports
  // active/exited — still "active", so `active === "active"` is the clean
  // predicate for both long-running and oneshot units.
  const services = units.map((u) => ({ ...u, ok: u.active === "active" }))
  const down = services.filter((s) => !s.ok)
  const version = await pbxVersion(versionPkg)
  const svcCommon = {
    kind: "3cx", role, name, host, reachable: true, version,
    services,
    servicesTotal: services.length,
    servicesOk: services.length - down.length,
    down: down.map((d) => ({ unit: d.unit, active: d.active, sub: d.sub })),
  }

  // --- SBC: outbound tunnel to the PBX (no local SIP listener) ---
  if (role === "sbc") {
    const tun = await tunnelStatus(pbxTunnelPort)
    return { ...svcCommon, tunnelUp: tun.up, tunnelPeer: tun.peer, tunnelPort: pbxTunnelPort }
  }

  // --- PBX: port liveness ---
  const sip = await Promise.all(
    sipPorts.map(async (port) => ({ port, listening: await portListening(host, port) })),
  )
  const sipOk = sip.every((p) => p.listening)
  const consoleProbe = { port: consolePort, listening: await portListening(host, consolePort) }

  // Watch branch SBCs from the PBX side, if any are configured.
  let sbcs: any = undefined
  let sbcTunnelCount: number | undefined = undefined
  if (Array.isArray(inst.sbcs) && inst.sbcs.length) {
    const peers = await inboundTunnelPeers(pbxTunnelPort)
    sbcTunnelCount = peers.length
    sbcs = inst.sbcs.map((s) => ({
      name: s.name,
      peer: s.peer,
      connected: s.peer ? peers.includes(s.peer) : peers.length > 0,
    }))
  }

  return { ...svcCommon, sip, sipOk, console: consoleProbe, ...(sbcs ? { sbcs, sbcTunnelCount } : {}) }
}

export function createThreeCXPlugin() {
  let refreshTimer: any = null

  const instancesOf = (plugin: MonitoringPluginBase): ThreeCXInstance[] => {
    const cfg = (plugin.config || {}) as ThreeCXConfig
    if (Array.isArray(cfg.instances) && cfg.instances.length) return cfg.instances
    // No explicit instances → a single on-box instance from the flat config.
    return [{
      name: cfg.name && cfg.name !== "3cx" ? cfg.name : undefined,
      role: cfg.role,
      host: cfg.host,
      unitGlob: cfg.unitGlob,
      versionPkg: cfg.versionPkg,
      sipPorts: cfg.sipPorts,
      consolePort: cfg.consolePort,
      pbxTunnelPort: cfg.pbxTunnelPort,
      sbcs: cfg.sbcs,
      systemctlBin: cfg.systemctlBin,
      uniqueId: cfg.uniqueId,
    }]
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await Promise.all(
      instancesOf(plugin).map(async (inst) => {
        const uid = inst.uniqueId || `3cx-${slug(inst.name || hostname())}`
        try {
          const data = await collect3cx(inst)
          await plugin.send(data, uid)
        } catch (e: any) {
          await plugin.send(
            { kind: "3cx", name: inst.name || hostname(), reachable: false, error: String(e?.message || e).slice(0, 160) },
            uid,
          )
        }
      }),
    )
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as ThreeCXConfig)?.refreshInterval || 60000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return createMonitoringPlugin(
    "3cx",
    "3cx",
    "3CX PBX monitor (service health, version, SIP/console liveness)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createThreeCXPlugin
