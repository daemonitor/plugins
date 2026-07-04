import { PluginBase } from "./BasePlugin"
import pluginsFactory from "../plugins/index"

export const PluginLoader = {
    // Load all plugins using the factories
    loadPlugins: async function(): Promise<PluginBase[]> {
        try {
            const plugins: PluginBase[] = [];
            
            // Create plugin instances using the factory functions
            const pluginFactories = pluginsFactory;
            
            for (const pluginName of Object.keys(pluginFactories)) {
                const createPlugin = pluginFactories[pluginName];
                if (typeof createPlugin === 'function') {
                    try {
                        const plugin = await createPlugin();
                        plugins.push(plugin);
                    } catch (err) {
                        console.error(`Error creating plugin ${pluginName}:`, err);
                    }
                }
            }
            
            return plugins;
        } catch (error) {
            console.error("Error loading plugins:", error);
            return [];
        }
    }
};
