import {
    arch,
    cpus,
    freemem,
    hostname,
    loadavg,
    networkInterfaces,
    platform,
    release,
    totalmem,
    type,
    uptime
} from "os"
import { MonitoringPlugin } from "~/index"


export class OSPlugin extends MonitoringPlugin {
    constructor() {
        super("os", "OS", "OS Monitoring Plugin")
    }

    async setup(): Promise<void> {
        // no setup required
        return Promise.resolve()
    }

    async refresh(): Promise<void> {
        const interfaces = networkInterfaces()
        const addresses: { [key: string]: { address: string, netmask: string, mac: string } } = {}
        for (let [key, value] of Object.entries(interfaces)) {
            if (value) {
                let found = value.find(port => ( port.family === "IPv4" ) && ( port.internal !== true ))
                if (found) {
                    let {address, netmask, mac} = found
                    addresses[key] = {address, netmask, mac}
                }
            }
        }

        await this.send({
            addresses,
            totalmem: totalmem(),
            freemem: freemem(),
            loadavg: loadavg(),
            uptime: uptime(),
            hostname: hostname(),
            platform: platform(),
            release: release(),
            type: type(),
            arch: arch(),
            cpus: cpus()
        })

    }

    async monitor(): Promise<any> {
        this.refreshTimer = setInterval(this.refresh.bind(this), this.config.refreshInterval || 5000)
    }

    async teardown(): Promise<void> {
        clearInterval(this.refreshTimer)
    }
}
