import { createHash, randomBytes } from "node:crypto"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin.js"
import { PluginManager } from "../../lib/PluginManager.js"

// IP cameras from any vendor: one still frame every few seconds, plus a status
// row per camera so a dead camera alerts like any other service.
//
// Two drivers cover most hardware without a vendor-specific one:
// - "snapshot": a URL that answers with a JPEG. Hikvision, Dahua/Amcrest, Axis,
//   Reolink and most NVRs have one; only the path differs.
// - "onvif": asks the camera for its snapshot URL (GetSnapshotUri), so nobody
//   has to look the path up.
// Both try no auth, then answer a Basic or Digest challenge.
//
// Frames go to the tenant beside the report, never inside it: a report is kept
// as history, and a frame every 10 seconds would fill it. Credentials stay here.

export interface CameraConfig {
  id?: string // stable unique id; derived from the address when absent
  name?: string
  driver?: "snapshot" | "onvif"
  url?: string // snapshot: the JPEG URL
  host?: string // onvif: camera address, optionally host:port
  profile?: number // onvif: which media profile, default the first
  username?: string
  password?: string
  frameInterval?: number // ms between frames, default 10s
}

interface PluginConfig {
  cameras?: CameraConfig[]
  frameInterval?: number
  refreshInterval?: number // ms between status reports, default 60s
  requestTimeout?: number
}

const DEFAULT_FRAME_MS = 10_000
const DEFAULT_REPORT_MS = 60_000
/** The tenant stores the latest frame in one Durable Object value. */
export const MAX_FRAME_BYTES = 1_900_000

const md5 = (s: string) => createHash("md5").update(s).digest("hex")

/** The Authorization header answering a Digest challenge (RFC 7616, MD5, qop=auth). */
export function digestHeader(challenge: string, method: string, uri: string, user: string, pass: string, cnonce = randomBytes(8).toString("hex")): string {
  const p: Record<string, string> = {}
  for (const m of challenge.replace(/^Digest\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3]
  const ha1 = md5(`${user}:${p.realm}:${pass}`)
  const ha2 = md5(`${method}:${uri}`)
  const qop = p.qop?.split(",").map((s) => s.trim()).includes("auth") ? "auth" : undefined
  const nc = "00000001"
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`)
  const parts = [`username="${user}"`, `realm="${p.realm}"`, `nonce="${p.nonce}"`, `uri="${uri}"`, `response="${response}"`]
  if (p.opaque) parts.push(`opaque="${p.opaque}"`)
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`)
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  return `Digest ${parts.join(", ")}`
}

/** fetch() that answers a 401 with Basic or Digest, once. */
export async function authFetch(url: string, init: RequestInit & { username?: string; password?: string; timeout?: number }): Promise<Response> {
  const { username, password, timeout = 10_000, ...rest } = init
  const go = (headers: Record<string, string> = {}) =>
    fetch(url, { ...rest, headers: { ...(rest.headers as any), ...headers }, signal: AbortSignal.timeout(timeout) })
  const first = await go()
  if (first.status !== 401 || !username) return first
  await first.body?.cancel()
  const challenge = first.headers.get("www-authenticate") || ""
  if (/^digest/i.test(challenge)) {
    const u = new URL(url)
    return go({ authorization: digestHeader(challenge, rest.method || "GET", u.pathname + u.search, username, password || "") })
  }
  return go({ authorization: `Basic ${Buffer.from(`${username}:${password || ""}`).toString("base64")}` })
}

/** Width and height from a JPEG's start-of-frame marker, or undefined. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] }
    }
    i += 2 + len
  }
  return undefined
}

// ---- ONVIF ----------------------------------------------------------------

const unescapeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`))?.[1]

/** WS-Security UsernameToken with a password digest, which ONVIF requires. */
export function wsSecurity(user: string, pass: string, now: Date, nonce = randomBytes(16)): string {
  const created = now.toISOString().replace(/\.\d+Z$/, "Z")
  const digest = createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created + pass)])).digest("base64")
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${user}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`
}

const envelope = (header: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">${header}<s:Body>${body}</s:Body></s:Envelope>`

/** The camera's clock as UTC, from GetSystemDateAndTime. */
export function parseCameraTime(xml: string): Date | undefined {
  const utc = xml.match(/UTCDateTime>([\s\S]*?)<\/(?:\w+:)?UTCDateTime/)?.[1]
  if (!utc) return undefined
  const n = (k: string) => Number(tag(utc, k))
  const d = new Date(Date.UTC(n("Year"), n("Month") - 1, n("Day"), n("Hour"), n("Minute"), n("Second")))
  return isNaN(+d) ? undefined : d
}

/**
 * Ask an ONVIF camera where its snapshot is. Signs with the camera's own clock,
 * because a UsernameToken more than a few seconds off is refused, and cheap
 * cameras are rarely on NTP.
 */
export async function onvifSnapshotUri(cam: CameraConfig, timeout: number): Promise<string> {
  const base = `http://${cam.host}`
  const call = async (url: string, body: string, signed: boolean, skewMs: number) => {
    const header = signed && cam.username ? wsSecurity(cam.username, cam.password || "", new Date(Date.now() + skewMs)) : ""
    const res = await authFetch(url, {
      method: "POST",
      headers: { "content-type": "application/soap+xml; charset=utf-8" },
      body: envelope(header, body),
      username: cam.username,
      password: cam.password,
      timeout,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`ONVIF ${body.match(/<\w+:(\w+)/)?.[1]}: HTTP ${res.status}${/NotAuthorized/i.test(text) ? " not authorized" : ""}`)
    return text
  }
  const device = `${base}/onvif/device_service`
  const clock = parseCameraTime(await call(device, "<tds:GetSystemDateAndTime/>", false, 0).catch(() => ""))
  const skew = clock ? +clock - Date.now() : 0
  const caps = await call(device, "<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>", true, skew)
  const media = caps.match(/Media>[\s\S]*?XAddr>([^<]+)</)?.[1]
  if (!media) throw new Error("ONVIF: camera lists no media service")
  // A camera behind NAT or a proxy reports its own LAN address; keep the host we reached.
  const mediaUrl = new URL(unescapeXml(media))
  const reached = new URL(base)
  mediaUrl.host = reached.host
  const profiles = await call(mediaUrl.href, "<trt:GetProfiles/>", true, skew)
  const tokens = [...profiles.matchAll(/Profiles[^>]*token="([^"]+)"/g)].map((m) => m[1])
  const token = tokens[cam.profile ?? 0]
  if (!token) throw new Error(`ONVIF: no media profile ${cam.profile ?? 0} (camera has ${tokens.length})`)
  const snap = await call(mediaUrl.href, `<trt:GetSnapshotUri><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetSnapshotUri>`, true, skew)
  const uri = snap.match(/MediaUri>[\s\S]*?Uri>([^<]+)</)?.[1]
  if (!uri) throw new Error("ONVIF: camera gave no snapshot URI")
  return unescapeXml(uri)
}

// ---- one camera -------------------------------------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

export function cameraId(cam: CameraConfig): string {
  if (cam.id) return cam.id
  if (cam.driver === "onvif") return `camera-${slug(`${cam.host}-p${cam.profile ?? 0}`)}`
  const u = new URL(String(cam.url))
  // The query counts: Dahua and others pick the channel there (snapshot.cgi?channel=2).
  return `camera-${slug(u.host + u.pathname + u.search)}`
}

/** The connector method that uploads a frame. Clients before it existed lack it. */
type FrameSender = { sendFrame?: (uniqueId: string, jpeg: Uint8Array) => Promise<void> }

export function createCameraPlugin() {
  const timers: any[] = []
  let warnedOldClient = false

  const watch = (plugin: MonitoringPluginBase, cfg: PluginConfig, cam: CameraConfig) => {
    const id = cameraId(cam)
    const name = cam.name || id
    const timeout = cfg.requestTimeout || 10_000
    const frameMs = Math.max(1000, cam.frameInterval || cfg.frameInterval || DEFAULT_FRAME_MS)
    const reportMs = cfg.refreshInterval || DEFAULT_REPORT_MS
    let snapshotUrl = cam.driver === "onvif" ? "" : String(cam.url || "")
    let lastReportAt = 0
    let lastReachable: boolean | undefined
    let busy = false

    const report = (body: Record<string, unknown>) =>
      plugin.send({ name, driver: cam.driver || "snapshot", host: cam.host || (cam.url ? new URL(cam.url).host : undefined), frameInterval: frameMs, timestamp: Date.now(), ...body }, id)

    const tick = async () => {
      if (busy) return // a slow camera skips frames rather than stacking requests
      busy = true
      const started = Date.now()
      let body: Record<string, unknown>
      try {
        if (!snapshotUrl) {
          if (cam.driver !== "onvif" || !cam.host) throw new Error(cam.driver === "onvif" ? "config needs host" : "config needs url")
          snapshotUrl = await onvifSnapshotUri(cam, timeout)
        }
        const res = await authFetch(snapshotUrl, { username: cam.username, password: cam.password, timeout })
        if (!res.ok) {
          await res.body?.cancel()
          throw new Error(res.status === 401 ? "snapshot refused: wrong username or password" : `snapshot: HTTP ${res.status}`)
        }
        const jpeg = new Uint8Array(await res.arrayBuffer())
        const size = jpegSize(jpeg)
        if (!size) throw new Error(`snapshot is not a JPEG (${res.headers.get("content-type") || "no content type"})`)
        if (jpeg.length > MAX_FRAME_BYTES) throw new Error(`frame is ${Math.round(jpeg.length / 1000)} KB, over ${MAX_FRAME_BYTES / 1000} KB; use a substream snapshot URL`)
        const at = Date.now()
        body = { reachable: true, ...size, bytes: jpeg.length, fetchMs: at - started, frameAt: at }
        // Report before the first frame: the tenant only takes frames for a camera it has a row for.
        if (lastReachable !== true || at - lastReportAt >= reportMs) {
          await report(body)
          lastReportAt = at
        }
        lastReachable = true
        for (const c of (PluginManager.API_CONNECTIONS || []) as FrameSender[]) {
          if (c.sendFrame) await c.sendFrame(id, jpeg)
          else if (!warnedOldClient) {
            warnedOldClient = true
            console.warn("camera: this agent's client can't upload frames; upgrade @daemonitor/client")
          }
        }
      } catch (e: any) {
        // An ONVIF camera may hand out a new URI after a reboot; ask again next time.
        if (cam.driver === "onvif") snapshotUrl = ""
        body = { reachable: false, error: String(e?.cause?.message || e?.message || e).slice(0, 160) }
        if (lastReachable !== false || Date.now() - lastReportAt >= reportMs) {
          await report(body).catch(() => {})
          lastReportAt = Date.now()
        }
        lastReachable = false
      } finally {
        busy = false
      }
    }

    tick()
    timers.push(setInterval(tick, frameMs))
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as PluginConfig
    const cams = cfg.cameras || []
    if (!cams.length) console.warn("camera: no cameras in config")
    const seen = new Set<string>()
    for (const cam of cams) {
      let id: string
      try {
        id = cameraId(cam)
      } catch {
        console.error(`camera: ${cam.name || "a camera"} has no usable url`)
        continue
      }
      if (seen.has(id)) {
        console.error(`camera: two cameras share the id ${id}; give one an "id"`)
        continue
      }
      seen.add(id)
      watch(plugin, cfg, cam)
    }
  }

  const teardownFn = async (): Promise<void> => {
    for (const t of timers.splice(0)) clearInterval(t)
  }

  const plugin = createMonitoringPlugin(
    "camera",
    "camera",
    "IP cameras: a still frame every few seconds and whether each camera answers",
    async () => {},
    monitorFn,
    async () => {},
    teardownFn,
  )
  return plugin
}

export default createCameraPlugin
