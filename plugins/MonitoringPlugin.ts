import BasePlugin from "~/plugins/BasePlugin"
import PluginManager from "~/PluginManager"

abstract class MonitoringPlugin extends BasePlugin {
    static currentPluginIndex = 0
    protected instanceName: string
    protected refreshTimer: any
    protected uniqueId: string
    protected pluginIndex: number

    protected constructor(alias: string, name: string, description: string) {
        super(alias, name, description)
        this.pluginIndex = MonitoringPlugin.currentPluginIndex++
        this.instanceName = this.config.name || name
        this.uniqueId = this.config?.uniqueId || this.alias + "-" + this.pluginIndex
    }

    public async send(data: any, unique_id?: string): Promise<void> {
        for (const apiConnection of PluginManager.API_CONNECTIONS) {
            await apiConnection.sendData({name: this.instanceName, ...data}, this.name, unique_id || this.uniqueId)
        }
    }

    abstract setup(): Promise<void>;

    abstract monitor(): Promise<any>;

    abstract refresh(): Promise<void>;

    abstract teardown(): Promise<void>;

    getName() {
        return this.name
    }
}

export default MonitoringPlugin
