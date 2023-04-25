import { EwelinkPlugin } from "../plugins/monitoring/EwelinkPlugin.js"
import { OSPlugin } from "../plugins/monitoring/OSPlugin.js"
import { PM2Plugin } from "../plugins/monitoring/PM2Plugin.js"
import { WebsitePlugin } from "../plugins/monitoring/WebsitePlugin.js"

export default {
    EwelinkPlugin,
    OSPlugin,
    PM2Plugin,
    WebsitePlugin
}

export const monitoringPlugins = [
    "EwelinkPlugin",
    "OSPlugin",
    "PM2Plugin",
    "WebsitePlugin"
]
