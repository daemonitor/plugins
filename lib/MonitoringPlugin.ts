import { PluginBase } from "./BasePlugin"
import { PluginManager } from "./PluginManager"

// Define the monitoring plugin interface
export type MonitoringPluginBase = PluginBase & {
  instanceName: string;
  refreshTimer?: any;
  uniqueId: string;
  pluginIndex: number;
  
  send: (data: any, unique_id?: string) => Promise<void>;
}

let monitoringPluginIndex = 0;

export function createMonitoringPlugin(
  alias: string,
  name: string,
  description: string,
  setupFn: (plugin: MonitoringPluginBase) => Promise<void>,
  monitorFn: (plugin: MonitoringPluginBase) => Promise<any>,
  refreshFn: (plugin: MonitoringPluginBase) => Promise<void>,
  teardownFn: (plugin: MonitoringPluginBase) => Promise<void>
): MonitoringPluginBase {
  const config = PluginManager.getConfig ? PluginManager.getConfig(alias) : {};
  const pluginIndex = monitoringPluginIndex++;
  const instanceName = config?.name || name;
  const uniqueId = config?.uniqueId || `${alias}-${pluginIndex}`;
  
  const plugin: MonitoringPluginBase = {
    alias,
    name,
    description,
    config,
    instanceName,
    uniqueId,
    pluginIndex,
    
    setup: async function() {
      return setupFn(this);
    },
    
    monitor: async function() {
      return monitorFn(this);
    },
    
    refresh: async function() {
      return refreshFn(this);
    },
    
    teardown: async function() {
      return teardownFn(this);
    },
    
    getName: function() {
      return this.name;
    },
    
    send: async function(data: any, unique_id?: string) {
      // Access API_CONNECTIONS from PluginManager
      const connections = PluginManager.API_CONNECTIONS || [];
      for (const apiConnection of connections) {
        await apiConnection.sendData(
          { name: this.instanceName, ...data }, 
          this.name, 
          unique_id || this.uniqueId
        );
      }
    }
  };
  
  return plugin;
}

