import * as http from "node:http"
import * as https from "node:https"
import { URL } from "node:url"
import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

// A direct-to-origin check, for sites fronted by a CDN (Cloudflare) where the
// public URL alone can't tell you the origin server is actually healthy — CF
// can keep serving stale/cached content while the origin is down. `url` is
// the address that actually reaches the origin (its own hostname/IP, e.g.
// origin.example.com), and `host` overrides the Host header so the origin's
// vhost config routes the request as if it came in on the public hostname
// (e.g. www.example.com) — the same trick as `curl -H "Host: ..."`.
interface OriginCheck {
    url: string
    host?: string
    headers?: Record<string, string>
    query?: Record<string, string>
    // Some origins only accept direct (non-CF) traffic carrying a marker the
    // reverse proxy/WAF checks for — supply it via `headers` or `query`
    // (e.g. { query: { cf: "1" } }), not a dedicated option, since the
    // marker's shape is entirely site-specific.
    insecure?: boolean // skip TLS verification, for origins with self-signed/internal certs
    timeout?: number
    // Falls back to the endpoint's own expectedStrings/unexpectedStrings/
    // expectedStatusCode when omitted, since it's normally the same content.
    expectedStrings?: string[]
    unexpectedStrings?: string[]
    expectedStatusCode?: number
}

interface Endpoint {
    name?: string
    url: string
    expectedStrings?: string[]
    unexpectedStrings?: string[]
    expectedStatusCode?: number
    timeout?: number
    origin?: OriginCheck
}

interface RawResult {
    status: number
    body: string
    duration: number
    error?: string
}

// Low-level GET that can hit one host (`target`) while presenting a different
// Host header. fetch() can't do this — Host is a forbidden header per the
// Fetch spec and is silently dropped — so this uses Node's http/https
// directly, which honors it.
function rawGet(target: string, opts: { host?: string; headers?: Record<string, string>; query?: Record<string, string>; insecure?: boolean; timeout?: number }): Promise<RawResult> {
    return new Promise((resolve) => {
        const start = Date.now()
        let u: URL
        try {
            u = new URL(target)
        } catch {
            resolve({ status: 0, body: "", duration: 0, error: `Invalid origin URL: ${target}` })
            return
        }
        for (const [k, v] of Object.entries(opts.query || {})) u.searchParams.set(k, v)

        const headers: Record<string, string> = { ...(opts.headers || {}) }
        if (opts.host) headers.Host = opts.host

        const lib = u.protocol === "http:" ? http : https
        const req = lib.request(
            {
                hostname: u.hostname,
                port: u.port || (u.protocol === "http:" ? 80 : 443),
                path: `${u.pathname}${u.search}`,
                method: "GET",
                headers,
                // Explicit servername pins TLS/SNI to the real connection
                // target. Without it, Node derives SNI from headers.Host,
                // which would validate the cert against the WRONG hostname
                // (the public one, not the origin actually being dialed).
                ...(u.protocol === "https:" ? { servername: u.hostname, rejectUnauthorized: !opts.insecure } : {}),
            },
            (res) => {
                let body = ""
                res.on("data", (c) => { body += c })
                res.on("end", () => resolve({ status: res.statusCode || 0, body, duration: Date.now() - start }))
            },
        )
        req.on("error", (err) => resolve({ status: 0, body: "", duration: Date.now() - start, error: err.message }))
        const timeoutMs = opts.timeout || 10000
        req.setTimeout(timeoutMs, () => {
            req.destroy()
            resolve({ status: 0, body: "", duration: Date.now() - start, error: "timeout" })
        })
        req.end()
    })
}

function evaluate(body: string, status: number, expected: string[], unexpected: string[], expectedStatusCode?: number) {
    // Report WHICH strings matched/went missing, not just booleans. For security
    // checks (injected-script IOCs, webshell markers, defacement canaries) the
    // alert is only actionable if it names the offending string — "IOC _ea_s
    // matched" vs. an opaque "check failed". `unexpectedStrings` doubles as an
    // IOC list; `expectedStrings` doubles as an integrity canary (its absence =
    // possible defacement). Kept as substring matches (no regex) to preserve the
    // existing config contract.
    const missingExpected = expected.filter((s) => body.indexOf(s) === -1)
    const matchedUnexpected = unexpected.filter((s) => body.indexOf(s) !== -1)
    const hasAllExpectedStrings = missingExpected.length === 0
    const hasAnyUnexpectedStrings = matchedUnexpected.length > 0
    const statusOk = expectedStatusCode ? status === expectedStatusCode : status >= 200 && status < 400
    return { ok: statusOk && hasAllExpectedStrings && !hasAnyUnexpectedStrings, hasAllExpectedStrings, hasAnyUnexpectedStrings, missingExpected, matchedUnexpected }
}

async function checkOrigin(ep: Endpoint): Promise<any> {
    const oc = ep.origin!
    const r = await rawGet(oc.url, {
        host: oc.host,
        headers: oc.headers,
        query: oc.query,
        insecure: oc.insecure,
        timeout: oc.timeout ?? ep.timeout,
    })
    if (r.error) {
        return { url: oc.url, host: oc.host, status: r.status, duration: r.duration, ok: false, error: r.error }
    }
    const { ok, hasAllExpectedStrings, hasAnyUnexpectedStrings, missingExpected, matchedUnexpected } = evaluate(
        r.body,
        r.status,
        oc.expectedStrings ?? ep.expectedStrings ?? [],
        oc.unexpectedStrings ?? ep.unexpectedStrings ?? [],
        oc.expectedStatusCode ?? ep.expectedStatusCode,
    )
    return { url: oc.url, host: oc.host, status: r.status, duration: r.duration, ok, hasAllExpectedStrings, hasAnyUnexpectedStrings, missingExpected, matchedUnexpected }
}

// HTTP uptime/content checks. Emits one client_state per endpoint, matching the
// frontend `web`/`website` fleetAdapter case ({ url, name, ok, status, duration }).
// Optionally two-tiered: the public URL (through Cloudflare/CDN) plus a direct
// origin check, nested under `origin`, so a CDN masking an origin outage still
// surfaces as a warning even while the public site keeps serving fine.
export function createWebsitePlugin() {
    let refreshTimer: any = null

    const check = async (plugin: MonitoringPluginBase, ep: Endpoint) => {
        const start = Date.now()
        const label = ep.name || ep.url
        const uid = `web-${(ep.name || ep.url).replace(/[^a-zA-Z0-9_.-]+/g, "-")}`
        let publicResult: any
        try {
            const ctrl = new AbortController()
            const t = ep.timeout ? setTimeout(() => ctrl.abort(), ep.timeout) : null
            const res = await fetch(ep.url, { signal: ctrl.signal, redirect: "follow" })
            if (t) clearTimeout(t)
            const body = await res.text()
            const duration = Date.now() - start

            const { ok, hasAllExpectedStrings, hasAnyUnexpectedStrings, missingExpected, matchedUnexpected } = evaluate(
                body,
                res.status,
                ep.expectedStrings || [],
                ep.unexpectedStrings || [],
                ep.expectedStatusCode,
            )

            publicResult = {
                name: label,
                url: res.url || ep.url,
                status: res.status,
                duration,
                ok,
                redirected: res.redirected,
                hasAllExpectedStrings,
                hasAnyUnexpectedStrings,
                missingExpected,
                matchedUnexpected,
            }
        } catch (err) {
            publicResult = {
                name: label,
                url: ep.url,
                status: 0,
                duration: Date.now() - start,
                ok: false,
                error: (err as Error).message,
            }
        }

        const origin = ep.origin?.url ? await checkOrigin(ep) : undefined

        // `ok` stays the PUBLIC tier's own result — don't collapse it with
        // origin.ok. The two tiers are different failure modes with different
        // severity (public down = real outage; origin-only down = CDN masking
        // a backend problem, still worth a warning). Collapsing them into one
        // boolean loses that distinction downstream (ingest branches on
        // `ok`/`origin.ok` separately to assign error vs warning).
        await plugin.send({ ...publicResult, origin }, uid)
    }

    const localEndpointsOf = (plugin: MonitoringPluginBase): Endpoint[] => {
        const cfg = plugin.config || {}
        if (Array.isArray(cfg.endpoints)) return cfg.endpoints
        if (cfg.url) {
            return [{
                name: cfg.name,
                url: cfg.url,
                expectedStrings: cfg.expectedStrings,
                unexpectedStrings: cfg.unexpectedStrings,
                expectedStatusCode: cfg.expectedStatusCode,
                timeout: cfg.timeout,
                origin: cfg.origin,
            }]
        }
        return []
    }

    // Server-managed endpoints: when the config carries a `configUrl` (the
    // daemonitor /api/monitors/for-client endpoint) and this client's
    // `systemKey`, monitors edited in the UI are pulled from there. The last
    // successful fetch is cached so a transient network/API failure keeps the
    // previous set running instead of silently dropping every check.
    let lastRemote: Endpoint[] | null = null
    const remoteEndpointsOf = async (plugin: MonitoringPluginBase): Promise<Endpoint[] | null> => {
        const cfg = plugin.config || {}
        const configUrl: string | undefined = cfg.configUrl
        const systemKey: string | undefined = cfg.systemKey
        if (!configUrl || !systemKey) return null
        try {
            const res = await fetch(configUrl, { headers: { "x-system-key": systemKey } })
            if (!res.ok) return lastRemote
            const body = await res.json()
            const eps = Array.isArray(body?.endpoints) ? (body.endpoints as Endpoint[]) : []
            lastRemote = eps
            return eps
        } catch {
            return lastRemote
        }
    }

    const endpointsOf = async (plugin: MonitoringPluginBase): Promise<Endpoint[]> => {
        const local = localEndpointsOf(plugin)
        const remote = await remoteEndpointsOf(plugin)
        if (remote == null) return local
        // Merge by name/url: server-managed monitors win, local-only ones
        // (defined directly in the config file) are kept alongside.
        const key = (e: Endpoint) => `${e.name || ""}|${e.url}`
        const merged = new Map<string, Endpoint>()
        for (const e of local) merged.set(key(e), e)
        for (const e of remote) merged.set(key(e), e)
        return [...merged.values()]
    }

    const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
        const eps = await endpointsOf(plugin)
        for (const ep of eps) {
            if (ep?.url) await check(plugin, ep)
        }
    }

    const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
        await refreshFn(plugin)
        refreshTimer = setInterval(() => refreshFn(plugin), plugin.config?.refreshInterval || 60000)
    }

    const teardownFn = async (): Promise<void> => {
        if (refreshTimer) clearInterval(refreshTimer)
        refreshTimer = null
    }

    return createMonitoringPlugin(
        "web",
        "web",
        "Website / HTTP uptime monitoring plugin",
        async () => {},
        monitorFn,
        refreshFn,
        teardownFn,
    )
}

export default createWebsitePlugin
