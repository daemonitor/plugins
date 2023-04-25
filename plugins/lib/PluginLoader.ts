import { BasePlugin } from "./BasePlugin.js"
import { MonitoringPlugin } from "./MonitoringPlugin.js"

// import pluginClasses from "./plugins.js"
import { EwelinkPlugin } from "../monitoring/EwelinkPlugin.js"
import { OSPlugin } from "../monitoring/OSPlugin.js"
import { PM2Plugin } from "../monitoring/PM2Plugin.js"
import { WebsitePlugin } from "../monitoring/WebsitePlugin.js"


export const pluginClasses: { [key: string]: any } = [
    EwelinkPlugin,
    OSPlugin,
    PM2Plugin,
    WebsitePlugin
]

export class PluginLoader {
    static async loadPlugins(): Promise<Array<BasePlugin | MonitoringPlugin>> {
        // const pluginsPath = path.join(__dirname, "../plugins")
        // const pluginFiles = ( await fs.readdir(pluginsPath) ).filter(file => /\.ts$/.test(file))
        const plugins: Array<BasePlugin | MonitoringPlugin> = []

        for (const file of Object.keys(pluginClasses)) {
            const PluginClass = pluginClasses[file]
            const pluginInstance = new PluginClass()
            plugins.push(pluginInstance)

            // try {
            //     const module = await import(pluginModulePath)
            //     const PluginClass = module.default
            //     const pluginInstance = new PluginClass()
            //     plugins.push(pluginInstance)
            // } catch (error) {
            //     console.error(`Failed to load plugin from "${pluginPath}":`, error)
            // }
        }
        return plugins
    }
}
