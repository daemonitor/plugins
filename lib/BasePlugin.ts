import { PluginConfigProvider } from "./PluginConfigProvider"

export interface PluginBase {
  alias: string;
  name: string;
  description: string;
  config: any;
  setup: () => Promise<void>;
  monitor: () => Promise<any>;
  refresh: () => Promise<void>;
  teardown: () => Promise<void>;
  getName: () => string;
}

let currentPluginIndex = 0;

export function createBasePlugin(
  alias: string,
  name: string,
  description: string,
  setupFn: (plugin: PluginBase) => Promise<void>,
  monitorFn: (plugin: PluginBase) => Promise<any>,
  refreshFn: (plugin: PluginBase) => Promise<void>,
  teardownFn: (plugin: PluginBase) => Promise<void>
): PluginBase {
  const config = PluginConfigProvider.get(alias);
  
  const plugin: PluginBase = {
    alias,
    name,
    description,
    config,
    
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
    }
  };
  
  return plugin;
}
