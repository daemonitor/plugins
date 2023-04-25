import { BasePlugin } from "./BasePlugin.js"
import { MonitoringPlugin } from "./MonitoringPlugin.js"

import PluginClasses from "../plugins/index.js"


export class PluginLoader {
    static async loadPlugins(): Promise<Array<BasePlugin | MonitoringPlugin>> {
        const plugins: Array<BasePlugin | MonitoringPlugin> = []

        const pluginClasses = PluginClasses
        for (const file of Object.keys(pluginClasses)) {
            const PluginClass = pluginClasses[file]
            const pluginInstance = new PluginClass()
            plugins.push(pluginInstance)
        }
        return plugins
    }
}
