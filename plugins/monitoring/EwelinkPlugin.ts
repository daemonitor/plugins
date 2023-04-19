import ewelink, { Device } from "ewelink-api"
import * as dotenv from "dotenv"
import MonitoringPlugin from "~/lib/plugins/MonitoringPlugin"
import Renderable from "~/lib/plugins/Renderable"

dotenv.config()

export default class extends MonitoringPlugin implements Renderable{

    connection?: ewelink
    devices?: Device[]

    constructor() {
        super("ewelink", "Ewelink", "Ewelink Addon")
        this.name = "Ewelink"
        this.description = "Ewelink Addon"
    }

    async setup() {
        if (!process.env.EWELINK_EMAIL || !process.env.EWELINK_PASSWORD) {
            console.error("EWELINK_EMAIL and EWELINK_PASSWORD environment variables must be set")
            return Promise.reject()
        }

        this.connection = new ewelink({
            email: process.env.EWELINK_EMAIL,
            password: process.env.EWELINK_PASSWORD
        })

        await this.refresh()

        return Promise.resolve()
    }

    async get(key: string) {
        let [deviceName, propertiesString] = key.split(":")
        deviceName = deviceName.toLowerCase()

        const properties = propertiesString.split(",")
        const device = this.devices?.find((d) => d.name.toLowerCase() === deviceName)
        if (!device) {
            return Promise.reject()
        }

        const values = {}
        for (const property of properties) {
            values[property] = device?.params[property]
        }
        return Promise.resolve(values)
    }

    async refresh() {
        /* get all devices */
        return this.connection.getDevices().then((devices: Device[]) => {
            this.devices = devices
        })
    }

    async monitor(): Promise<any> {
        this.refreshTimer = setInterval(this.refresh.bind(this), this.config.refreshInterval || 5000)
    }

    async teardown(): Promise<void> {
        clearInterval(this.refreshTimer)
    }


    render() {
        return h(
            'div',
            Array.from({ length: 20 }).map(() => {
                return h('p', 'hi')
            })
        )
    }
}

