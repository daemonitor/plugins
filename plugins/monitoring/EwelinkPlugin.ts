import ewelink, { Device } from "ewelink-api"
import * as dotenv from "dotenv"
import { MonitoringPlugin } from "../../lib/MonitoringPlugin.js"
import { Renderable } from "@daemonitor/common"

dotenv.config()

export class EwelinkPlugin extends MonitoringPlugin implements Renderable {

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

        this.refresh().then(() => {
        })

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
            if (Array.isArray(devices) && ( Symbol.iterator in Object(devices) )) {
                this.devices = devices
                for (const device of this.devices) {
                    this.send(device, device.deviceid)
                }
            } else {
                console.error("EwelinkPlugin: Invalid response from getDevices()", devices)
            }
        })
    }

    async monitor(): Promise<any> {
        this.refreshTimer = setInterval(this.refresh.bind(this), this.config.refreshInterval || 30000)
    }

    async teardown(): Promise<void> {
        clearInterval(this.refreshTimer)
    }


    async render(): Promise<any> {
        return this.devices
    }
}

