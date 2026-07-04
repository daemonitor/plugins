import { createMonitoringPlugin, MonitoringPluginBase } from "../../lib/MonitoringPlugin"

// Factory function to create PM2 plugin
export function createPM2Plugin() {
  // Create plugin state
  let pm2Instance: any = null;
  let refreshTimer: any = null;

  // Define setup function
  const setupFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    try {
      // First, check if PM2 is available globally (injected by the client-test)
      if ((global as any).pm2Library) {
        console.log("Using globally provided PM2 instance");
        pm2Instance = (global as any).pm2Library;
      } else {
        // Otherwise use dynamic import approach which is ESM friendly
        try {
          const pm2Module = await import('pm2');
          pm2Instance = pm2Module.default || pm2Module;
          
          // If import fails, try CommonJS require as fallback
          if (!pm2Instance) {
            try {
              // @ts-ignore - Dynamically require pm2
              pm2Instance = require('pm2');
            } catch (requireErr) {
              console.error("Failed to require PM2:", requireErr);
              throw new Error(`Neither import nor require could load pm2: ${requireErr.message}`);
            }
          }
        } catch (err) {
          console.error("Failed to import PM2:", err);
          throw new Error(`PM2 import failed: ${err.message}`);
        }
      }
      
      // Return a promise for the PM2 connection
      return new Promise<void>((resolve, reject) => {
        pm2Instance.connect((err) => {
          if (err) {
            console.error("PM2 connection failed:", err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } catch (e) {
      console.error("PM2Plugin setup error:", e);
      throw e;
    }
  };

  // Define refresh function
  const refreshFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    if (!pm2Instance) {
      console.error("PM2 instance not initialized");
      return;
    }
    
    const instanceCounts: Record<string, number> = {};

    pm2Instance.list(async (err, list) => {
      if (!err) {
        for (const p of list) {
          let {
            pid, name, pm_id, monit,
          } = p;

          if (instanceCounts[name] === undefined) {
            instanceCounts[name] = 0;
          }

          const index = instanceCounts[name]++;
          const instance_id = `pm2-${name}-${index}`;

          let {
            username,
            watch,
            axm_options,
            axm_monitor,
            node_version,
            unique_id,
            pm_name,
            restart_time,
            created_at,
            unstable_restarts,
            autorestart,
            status,
            pm_uptime
          } = p.pm2_env as any;

          const payload = {
            updated: (new Date()).getTime(),
            created_at,
            unstable_restarts,
            restarts: restart_time,
            pid,
            name,
            pm_id,
            monit,
            username,
            watch,
            axm_options,
            axm_monitor,
            node_version,
            unique_id,
            restart_time,
            autorestart,
            status,
            pm_uptime,
          };
          
          await plugin.send(payload, instance_id);
        }
      } else {
        console.error(err);
      }
    });
  };

  // Define monitor function
  const monitorFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    refreshTimer = setInterval(() => refreshFn(plugin), plugin.config.refreshInterval || 5000);
  };

  // Define teardown function
  const teardownFn = async (plugin: MonitoringPluginBase): Promise<void> => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
  };

  // Create and return the plugin
  return createMonitoringPlugin(
    "pm2",
    "PM2",
    "PM2 Monitoring Plugin",
    setupFn,
    monitorFn,
    refreshFn,
    teardownFn
  );
}

// Export a default factory function for plugin loader
export default createPM2Plugin;
