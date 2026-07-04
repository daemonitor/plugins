import { PluginLoader } from "./PluginLoader"
import { IConnector } from "@daemonitor/common"
import { PluginBase } from "./BasePlugin"
import { PluginConfigProvider } from "./PluginConfigProvider"

interface PluginManagerState {
  availablePlugins: PluginBase[];
  activePlugins: PluginBase[];
  configuredPlugins: string[];
}

// Singleton state
const state: PluginManagerState = {
  availablePlugins: [],
  activePlugins: [],
  configuredPlugins: []
};

// Export as namespace instead of class
export const PluginManager = {
  // Global connections array
  API_CONNECTIONS: [] as IConnector[],

  // Initialize the manager. Accepts either the legacy string[] of plugin
  // aliases, or the full client config object ({ plugins: [...], docker: {...}, ... }).
  // Passing the full object also populates PluginConfigProvider so plugins
  // receive their per-alias config section (dockerBin, refreshInterval, etc.).
  initialize: async function(config: string[] | Record<string, any>): Promise<void> {
    let configuredPlugins: string[];
    if (Array.isArray(config)) {
      configuredPlugins = config;
    } else {
      configuredPlugins = config?.plugins || [];
      PluginConfigProvider.loadAll(config);
    }
    state.configuredPlugins = configuredPlugins.map((p) => String(p).toLowerCase());
    await this.loadPlugins();
    await this.setupAll();
    return;
  },

  // Load all available plugins
  loadPlugins: async function(): Promise<void> {
    try {
      const plugins = await PluginLoader.loadPlugins();
      
      if (!plugins) {
        throw new Error("Failed to load plugins.");
      } else if (plugins.length === 0) {
        throw new Error("No plugins found.");
      } else {
        console.log(`Loaded ${plugins.length} plugins.`);
      }
      
      state.availablePlugins = plugins;
    } catch (error) {
      console.error("Error loading plugins:", error);
      throw error;
    }
  },

  // Add a connector for plugins to use
  addConnector: function(apiConnection: IConnector): void {
    this.API_CONNECTIONS.push(apiConnection);
  },

  // Get connections for plugins
  getConnections: function(): IConnector[] {
    return this.API_CONNECTIONS;
  },

  // Get config for a plugin by alias
  getConfig: function(alias: string): any {
    return PluginConfigProvider.get(alias);
  },

  // Set up all the configured plugins
  setupAll: async function(): Promise<void> {
    console.log("Setting up plugins...");

    console.log("Configured plugins:", state.configuredPlugins.join(", "));
    if (!state.configuredPlugins || state.configuredPlugins.length === 0) {
      throw new Error("No plugins configured. Set up config.json first.");
    }

    state.activePlugins = state.availablePlugins.filter(plugin => {
      return state.configuredPlugins.includes(plugin.getName().toLowerCase());
    });

    if (state.activePlugins.length === 0) {
      throw new Error("No plugins to set up.");
    }
    
    for (const plugin of state.activePlugins) {
      await plugin.setup();
    }
  },

  // Start monitoring with all plugins
  monitorAll: async function(): Promise<any[]> {
    const results = [];
    
    if (!state.availablePlugins || state.availablePlugins.length === 0) {
      throw new Error("Plugins not loaded yet! Call loadPlugins() first.");
    }
    
    if (this.API_CONNECTIONS.length === 0) {
      throw new Error("No connections loaded yet! Call addConnector() first.");
    }

    console.log(`Monitoring ${state.activePlugins.length} plugins...`);
    
    for (const plugin of state.activePlugins) {
      console.log(` + ${plugin.getName()}`);
      const data = await plugin.monitor();
      results.push(data);
    }

    return results;
  },

  // Tear down all plugins
  teardownAll: async function(): Promise<void> {
    for (const plugin of state.activePlugins) {
      await plugin.teardown();
    }
  }
};

