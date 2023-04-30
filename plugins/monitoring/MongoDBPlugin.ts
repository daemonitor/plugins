import { MonitoringPlugin } from "../../lib/MonitoringPlugin.js"

import { spawn } from "node:child_process"


export class MongoDBPlugin extends MonitoringPlugin {

    childProcess?: any

    constructor() {
        super("mongodb", "mongodb", "MongoDB Monitoring Plugin")
    }

    async setup(): Promise<void> {
        // no setup required
        return Promise.resolve()
    }

    async refresh(): Promise<void> {
        // get mongodb db.serverStatus
    }

    async monitor(): Promise<any> {
        // this.refreshTimer = setInterval(this.refresh.bind(this), this.config.refreshInterval || 5000)
        this.childProcess = spawn("mongostat", ["--json", "mongodb://localhost:27017", "10"])
        this.childProcess.stdout.on("data", (input) => {
            const jsonObject = JSON.parse(input.toString())
            if (!jsonObject["localhost:27017"]) {
                return
            }
            const data = jsonObject["localhost:27017"]
            this.send(data, "mongodb-localhost:27017")
        })
    }

    async teardown(): Promise<void> {
        this.childProcess.kill()
    }
}
