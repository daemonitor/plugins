import { PluginLoader } from "./index.js"
import { IConnector } from "@daemonitor/common"
import { BasePlugin } from "~/plugins/lib/BasePlugin.js"
import { MonitoringPlugin } from "~/plugins/lib/MonitoringPlugin.js"

export class PluginManager {

    static API_CONNECTIONS: IConnector[] = []
    private availablePlugins: Array<MonitoringPlugin | BasePlugin>
    private activePlugins: Array<MonitoringPlugin | BasePlugin>
    private configuredPlugins: any

    constructor(configuredPlugins: any) {
        this.availablePlugins = []
        this.activePlugins = []
        this.configuredPlugins = configuredPlugins

    }

    async initialize(): Promise<void> {
        return this.loadPlugins().then(
            () => this.setupAll()
        )
    }

    async loadPlugins(): Promise<void> {
        return await PluginLoader.loadPlugins().then(plugins => {
            if (!plugins) {
                throw new Error("Failed to load plugins.")
            } else if (plugins.length === 0) {
                throw new Error("No plugins found.")
            } else {
                console.log(`Loaded ${plugins.length} plugins.`)
            }
            this.availablePlugins = plugins
        })
    }

    async addApiConnection(apiConnection: IConnector): Promise<void> {
        PluginManager.API_CONNECTIONS.push(apiConnection)
    }

    async setupAll(): Promise<void> {
        console.log("Setting up plugins...")

        // const configuredPlugins = await AppConfigProvider.get("plugins")
        console.log("Configured plugins:", this.configuredPlugins.join(", "))
        if (!this.configuredPlugins) throw new Error("No plugins configured. Set up config.json first.")

        this.activePlugins = this.availablePlugins.filter(plugin => {
            return this.configuredPlugins.includes(plugin.getName().toLowerCase())
        })

        if (!this.activePlugins) throw new Error("No plugins to set up.")
        for (const plugin of this.activePlugins) {
            await plugin.setup()
        }
    }

    async monitorAll(): Promise<any[]> {
        const results = []
        if (!this.availablePlugins) throw new Error("Plugins not loaded yet! Call loadPlugins() first.")
        if (this.availablePlugins.length === 0) throw new Error("No plugins loaded.")
        if (!PluginManager.API_CONNECTIONS || PluginManager.API_CONNECTIONS.length === 0)
            throw new Error("No API connections loaded yet! Call addApiConnection() first.")

        console.log(`Starting monitoring of ${this.activePlugins.length} plugins...`)
        for (const plugin of this.activePlugins) {
            console.log(` + ${plugin.getName()}`)
            const data = plugin.monitor()
            results.push(data)
        }

        return results
    }

    async teardownAll(): Promise<void> {
        for (const plugin of this.activePlugins) {
            await plugin.teardown()
        }
    }
}

