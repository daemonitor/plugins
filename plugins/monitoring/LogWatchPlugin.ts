import { stat, open } from "node:fs/promises"
import * as path from "node:path"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

// Access-log watcher. Tails nginx/apache access logs on the WP host and applies
// the log-class detection rules from the Archpaper handoff — the ones that are
// invisible to a poll-based snapshot because they live in the per-request stream:
//   • WP2Shell:      POST /wp-json/batch/v1 (or ?rest_route=/batch/v1) → 207
//   • correlation:   batch/v1 exploit followed by a wp-login.php → 302 (success)
//   • webshell exec: a .php under wp-content/uploads (never legit) or a plugin
//                    dir invoked with a command-style/base64 query
//   • xmlrpc brute:  a burst of POST /xmlrpc.php from one IP
//
// It works identically for Cloudflare-fronted and direct-origin sites (it reads
// the log at the origin), so it covers the "Mixed" fleet with one mechanism. The
// rule logic lives HERE (it needs the raw lines); the server just turns each
// emitted finding into a notification (clientstate/update.put.ts, case
// "logwatch"). Findings are per-IP/per-path keyed so an ongoing attack alerts
// once (until read) rather than every poll.
//
// IMPORTANT: the log must record the REAL client IP. Behind Cloudflare, configure
// nginx real_ip (set_real_ip_from + CF-Connecting-IP) so $remote_addr is the
// visitor, not the CF edge — otherwise every finding points at a Cloudflare IP.

interface LogSource {
  name?: string
  path: string // absolute path to the access log
  // Start reading from the beginning on first sight (replays history — off by
  // default so we don't alert on old lines or load a huge file).
  fromStart?: boolean
}

interface LogWatchConfig {
  sources?: LogSource[]
  path?: string // single-source shorthand
  name?: string
  fromStart?: boolean
  refreshInterval?: number // tail cadence (default 60s)
  xmlrpcBurstThreshold?: number // POST /xmlrpc.php per IP per window to alert (default 20)
}

interface SourceState {
  offset: number
  remainder: string
  inited: boolean
}

interface Entry {
  ip: string
  method: string
  path: string // request target (may include query)
  status: number
  ua: string
}

// Cap a single tail read so a rotated-in giant file (or fromStart on a large
// log) can't blow up memory — read at most the last MAX_READ bytes.
const MAX_READ = 5 * 1024 * 1024

// Field-position TOLERANT parsing. Log layouts vary a lot across these hosts:
//   • standard combined:   `1.2.3.4 - - [t] "GET / HTTP/1.1" 200 ...`
//   • vhost-first:          `example.com - 1.2.3.4 - - [t] "GET / HTTP/1.1" 200`
//   • CF combined_with_host: `host - <edge_ip> - <cf_connecting_ip> - - [t] "GET .." "200"`
// So neither the IP column NOR the status quoting is fixed. We therefore:
//   1. pull the request + status from the quoted "$request" run (status may be
//      bare or quoted → allow an optional leading quote), and
//   2. take the LAST IP token BEFORE the `[timestamp]` as the client. That is
//      the real requester in every layout here: when Cloudflare's
//      $http_cf_connecting_ip is present it is logged AFTER $remote_addr (the CF
//      edge), so "last IP" is the visitor, not the edge; when it's absent there
//      is a single IP ($remote_addr) and "last" == "only".
const REQ = /"([A-Z]+)\s+([^ "]+)[^"]*"\s+"?(\d{3})/
const IP_TOKEN = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4})$/

function parseLine(line: string): Entry | null {
  const rq = REQ.exec(line)
  if (!rq) return null
  const br = line.indexOf("[")
  const pre = br > 0 ? line.slice(0, br) : line
  const tokens = pre.split(/\s+/)
  const ips = tokens.filter((t) => IP_TOKEN.test(t))
  const ip = ips.length ? ips[ips.length - 1] : (tokens.find(Boolean) || "")
  return { ip, method: rq[1], path: rq[2], status: Number(rq[3]), ua: "" }
}

const SUSPICIOUS_QUERY = /(?:^|[?&])(c|k|cmd|exec|e|q|f|file|dir|download|0|1|a)=/i
const BASE64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/
const UPLOADS_PHP = /\/wp-content\/uploads\/.*\.php$/i
const PLUGIN_PHP = /\/wp-content\/(?:plugins|mu-plugins)\/.*\.php$/i
const BATCH_PATH = /^\/wp-json\/batch\/v1|rest_route=\/?batch\/v1/i

// Read new bytes since last offset, advancing state. Handles rotation (file
// shrank → restart at 0) and partial trailing lines (buffered in remainder).
async function readNew(source: LogSource, st: SourceState): Promise<string[]> {
  let size: number
  try {
    size = (await stat(source.path)).size
  } catch {
    return [] // file missing this cycle; try again next tick
  }

  if (!st.inited) {
    st.offset = source.fromStart ? 0 : size
    st.remainder = ""
    st.inited = true
  }
  if (size < st.offset) {
    // Truncated or rotated in place.
    st.offset = 0
    st.remainder = ""
  }
  if (size <= st.offset) return [] // nothing new

  let start = st.offset
  if (size - start > MAX_READ) start = size - MAX_READ // bound the read
  const len = size - start
  const buf = Buffer.allocUnsafe(len)
  const fh = await open(source.path, "r")
  try {
    await fh.read(buf, 0, len, start)
  } finally {
    await fh.close()
  }
  st.offset = size

  const text = st.remainder + buf.toString("utf8")
  const lines = text.split("\n")
  st.remainder = lines.pop() ?? "" // last element is a partial line (no newline)
  return lines
}

function analyze(lines: string[], cfg: LogWatchConfig, windowSec: number): { findings: any[]; counts: any } {
  const burstThreshold = cfg.xmlrpcBurstThreshold ?? 20
  const batchIps = new Map<string, number>() // ip → count of batch/v1 → 207
  const loginOkIps = new Set<string>() // ip with POST wp-login → 302
  const xmlrpcByIp = new Map<string, number>() // ip → POST xmlrpc count
  const webshell = new Map<string, { ip: string; count: number }>() // pathNoQuery → sample
  let total = 0

  for (const line of lines) {
    const e = parseLine(line)
    if (!e) continue
    total++
    const qIdx = e.path.indexOf("?")
    const pathNoQuery = qIdx === -1 ? e.path : e.path.slice(0, qIdx)
    const query = qIdx === -1 ? "" : e.path.slice(qIdx + 1)

    if ((BATCH_PATH.test(e.path) || pathNoQuery === "/wp-json/batch/v1") && e.status === 207) {
      batchIps.set(e.ip, (batchIps.get(e.ip) || 0) + 1)
    }
    if (pathNoQuery === "/wp-login.php" && e.method === "POST" && e.status === 302) {
      loginOkIps.add(e.ip)
    }
    if (pathNoQuery === "/xmlrpc.php" && e.method === "POST") {
      xmlrpcByIp.set(e.ip, (xmlrpcByIp.get(e.ip) || 0) + 1)
    }
    // A .php under uploads is never legitimate; under a plugin dir it's only
    // suspicious with a command-style or base64 query (webshell invocation).
    const isUploadsPhp = UPLOADS_PHP.test(pathNoQuery)
    const isPluginShell = PLUGIN_PHP.test(pathNoQuery) && (SUSPICIOUS_QUERY.test(query) || BASE64_BLOB.test(query))
    if (isUploadsPhp || isPluginShell) {
      const cur = webshell.get(pathNoQuery) || { ip: e.ip, count: 0 }
      cur.count++
      webshell.set(pathNoQuery, cur)
    }
  }

  const findings: any[] = []
  // Correlation is the highest-signal event — flag it before the standalone
  // batch/v1 finding so it leads.
  for (const [ip, count] of batchIps) {
    if (loginOkIps.has(ip)) {
      findings.push({
        rule: "batch-then-login", key: `batch-login:${ip}`, severity: "error", ip,
        path: "/wp-json/batch/v1",
        title: "WP2Shell: exploit + admin login",
        detail: `${ip}: batch/v1 exploit (${count}×) followed by a successful wp-login (HTTP 302) — likely account takeover`,
      })
    } else {
      findings.push({
        rule: "wp-batch-207", key: `batchv1:${ip}`, severity: "error", ip,
        path: "/wp-json/batch/v1",
        title: "WP2Shell batch/v1 exploit",
        detail: `${ip}: POST /wp-json/batch/v1 → 207 (${count}×) — near-zero false positives`,
      })
    }
  }
  for (const [p, v] of webshell) {
    findings.push({
      rule: "webshell-exec", key: `webshell:${p}`, severity: "error", ip: v.ip, path: p,
      title: "Webshell execution",
      detail: `${v.ip} invoked ${p} (${v.count}×) — executable PHP in an upload/plugin path`,
    })
  }
  for (const [ip, count] of xmlrpcByIp) {
    if (count >= burstThreshold) {
      findings.push({
        rule: "xmlrpc-burst", key: `xmlrpc:${ip}`, severity: count >= burstThreshold * 5 ? "error" : "warning", ip,
        path: "/xmlrpc.php",
        title: "xmlrpc.php brute-force / amplification",
        detail: `${ip}: ${count} POST /xmlrpc.php in ~${windowSec}s (threshold ${burstThreshold})`,
      })
    }
  }

  const counts = {
    total,
    batchV1: [...batchIps.values()].reduce((a, b) => a + b, 0),
    xmlrpcPosts: [...xmlrpcByIp.values()].reduce((a, b) => a + b, 0),
    webshellHits: [...webshell.values()].reduce((a, b) => a + b.count, 0),
    loginSuccess: loginOkIps.size,
  }
  return { findings, counts }
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
}

export function createLogWatchPlugin() {
  let refreshTimer: any = null
  const states = new Map<string, SourceState>()

  const sourcesOf = (plugin: MonitoringPluginBase): LogSource[] => {
    const cfg = (plugin.config || {}) as LogWatchConfig
    if (Array.isArray(cfg.sources) && cfg.sources.length) return cfg.sources
    if (cfg.path) return [{ name: cfg.name, path: cfg.path, fromStart: cfg.fromStart }]
    return []
  }

  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    const cfg = (plugin.config || {}) as LogWatchConfig
    const windowSec = Math.round((cfg.refreshInterval || 60000) / 1000)
    for (const source of sourcesOf(plugin)) {
      if (!source?.path) continue
      const label = source.name || path.basename(source.path)
      const uid = `log-${slug(source.name || source.path)}`
      let st = states.get(source.path)
      if (!st) { st = { offset: 0, remainder: "", inited: false }; states.set(source.path, st) }
      try {
        const lines = await readNew(source, st)
        const { findings, counts } = analyze(lines, cfg, windowSec)
        await plugin.send({ name: label, source: label, path: source.path, window: windowSec, counts, findings }, uid)
      } catch (e: any) {
        await plugin.send({ name: label, source: label, path: source.path, error: String(e?.message || e).slice(0, 160), findings: [] }, uid)
      }
    }
  }

  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    await refreshFn(plugin)
    refreshTimer = setInterval(() => refreshFn(plugin), (plugin.config as LogWatchConfig)?.refreshInterval || 60000)
  }

  const teardownFn = async (): Promise<void> => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
    states.clear()
  }

  return createMonitoringPlugin(
    "logwatch",
    "logwatch",
    "Access-log security watcher (WP2Shell / webshell / xmlrpc)",
    async () => {},
    monitorFn,
    refreshFn,
    teardownFn,
  )
}

export default createLogWatchPlugin
