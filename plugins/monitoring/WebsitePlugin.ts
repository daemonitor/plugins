import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

interface Endpoint {
    name?: string
    url: string
    expectedStrings?: string[]
    unexpectedStrings?: string[]
    expectedStatusCode?: number
    timeout?: number
}

// HTTP uptime/content checks. Emits one client_state per endpoint, matching the
// frontend `web`/`website` fleetAdapter case ({ url, name, ok, status, duration }).
export function createWebsitePlugin() {
    let refreshTimer: any = null

    const check = async (plugin: MonitoringPluginBase, ep: Endpoint) => {
        const start = Date.now()
        const label = ep.name || ep.url
        const uid = `web-${(ep.name || ep.url).replace(/[^a-zA-Z0-9_.-]+/g, "-")}`
        try {
            const ctrl = new AbortController()
            const t = ep.timeout ? setTimeout(() => ctrl.abort(), ep.timeout) : null
            const res = await fetch(ep.url, { signal: ctrl.signal, redirect: "follow" })
            if (t) clearTimeout(t)
            const body = await res.text()
            const duration = Date.now() - start

            const expected = ep.expectedStrings || []
            const unexpected = ep.unexpectedStrings || []
            const hasAllExpected = expected.every((s) => body.indexOf(s) !== -1)
            const hasAnyUnexpected = unexpected.some((s) => body.indexOf(s) !== -1)
            const statusOk = ep.expectedStatusCode ? res.status === ep.expectedStatusCode : res.ok
            const ok = statusOk && hasAllExpected && !hasAnyUnexpected

            await plugin.send(
                {
                    name: label,
                    url: res.url || ep.url,
                    status: res.status,
                    duration,
                    ok,
                    redirected: res.redirected,
                    hasAllExpectedStrings: hasAllExpected,
                    hasAnyUnexpectedStrings: hasAnyUnexpected,
                },
                uid,
            )
        } catch (err) {
            await plugin.send(
                {
                    name: label,
                    url: ep.url,
                    status: 0,
                    duration: Date.now() - start,
                    ok: false,
                    error: (err as Error).message,
                },
                uid,
            )
        }
    }

    const endpointsOf = (plugin: MonitoringPluginBase): Endpoint[] => {
        const cfg = plugin.config || {}
        if (Array.isArray(cfg.endpoints)) return cfg.endpoints
        if (cfg.url) return [{ name: cfg.name, url: cfg.url, expectedStrings: cfg.expectedStrings, unexpectedStrings: cfg.unexpectedStrings }]
        return []
    }

    const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
        const eps = endpointsOf(plugin)
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
