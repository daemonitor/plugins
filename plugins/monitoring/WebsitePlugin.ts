import { MonitoringPlugin } from "~/index"

class WebSitePlugin extends MonitoringPlugin {
    constructor() {
        super("website", "Website", "Website Monitoring Plugin")
    }

    async setup(): Promise<void> {
        // no setup required
        return Promise.resolve()
    }

    async refresh(): Promise<void> {
        const startTimestamp = Date.now()
        const result = await fetch(this.config.url)
        const endTimestamp = Date.now()
        const text = await result.text()
        const status = result.status
        const headers = result.headers
        const ok = result.ok
        const redirected = result.redirected
        const type = result.type
        const url = result.url
        const body = text
        const duration = endTimestamp - startTimestamp


        const expectedStrings = this.config.expectedStrings || []
        const unexpectedStrings = this.config.unexpectedStrings || []

        const hasAllExpectedStrings = expectedStrings.every(expectedString => body.indexOf(expectedString) !== -1)
        const hasAnyUnexpectedStrings = unexpectedStrings.some(unexpectedString => body.indexOf(unexpectedString) !== -1)

        await this.send({
            status,
            duration,
            headers,
            ok,
            redirected,
            type,
            url,
            body,
            hasAllExpectedStrings,
            hasAnyUnexpectedStrings
        })
    }

    async monitor(): Promise<any> {
        this.refreshTimer = setInterval(this.refresh.bind(this), this.config.refreshInterval || 5000)
    }

    async teardown(): Promise<void> {
        clearInterval(this.refreshTimer)
    }
}

export default WebSitePlugin
