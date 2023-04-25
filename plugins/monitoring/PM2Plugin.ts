import pm2 from "pm2"
import { MonitoringPlugin } from "../../lib/MonitoringPlugin.js"

export  class PM2Plugin extends MonitoringPlugin {
    constructor() {
        super("pm2", "PM2", "PM2 Monitoring Plugin")
    }

    async setup(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                pm2.connect(async (err) => {
                    if (err) {
                        console.error(err)
                        reject(err)
                    } else {
                        resolve()
                    }
                })
            } catch (e) {
                console.error("ERROR", e)
                reject(e)
            }
        })
    }

    async refresh(): Promise<void> {
        pm2.list(async (err, list) => {
                if (!err) {
                    for (const p of list) {
                        let {
                            pid, name, pm_id, monit,
                            // exit_code,
                            // prev_restart_delay,
                            // versioning,
                            // axm_dynamic,
                            // axm_actions,
                            // merge_logs,
                            // vizion,
                            // instance_var,
                            // pmx,
                            // automation,
                            // treekill,
                            // windowsHide,
                            // kill_retry_time
                        } = p

                        let {
                            username,
                            watch,
                            axm_options,
                            axm_monitor,
                            node_version,
                            unique_id,
                            restart_time,
                            created_at,
                            unstable_restarts,
                            autorestart,
                            status,
                            pm_uptime
                        } = p.pm2_env as any

                        const payload = {
                            updated: ( new Date() ).getTime(),
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
                        }
                        await this.send(payload, `${unique_id}-${pm_id}`)
                    }
                } else {
                    console.error(err)
                }
            }
        )
    }

    async monitor(): Promise<any> {
        this.refreshTimer = setInterval(this.refresh.bind(this), this.config.refreshInterval || 5000)
    }

    async teardown(): Promise<void> {
        clearInterval(this.refreshTimer)
    }
}
