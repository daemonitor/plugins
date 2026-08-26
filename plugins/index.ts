// Import plugin factory functions
import { createPM2Plugin } from "./monitoring/PM2Plugin.js"
import { createDockerPlugin } from "./monitoring/DockerPlugin.js"
import { createLxcPlugin } from "./monitoring/LxcPlugin.js"
import { createOSPlugin } from "./monitoring/OSPlugin.js"
import { createWebsitePlugin } from "./monitoring/WebsitePlugin.js"
import { createWordpressPlugin } from "./monitoring/WordpressPlugin.js"
import { createLogWatchPlugin } from "./monitoring/LogWatchPlugin.js"
import { createNetScanPlugin } from "./monitoring/NetScanPlugin.js"
import { createSnmpPlugin } from "./monitoring/SnmpPlugin.js"
import { createThreeCXPlugin } from "./monitoring/ThreeCXPlugin.js"
import { createTplinkPlugin } from "./monitoring/TplinkPlugin.js"

// In future, implement other plugin factory functions using the same pattern
// import { createOSPlugin } from "./monitoring/OSPlugin.js"
// import { createMongoDBPlugin } from "./monitoring/MongoDBPlugin.js"
// import { createWebsitePlugin } from "./monitoring/WebsitePlugin.js"
// import { createCloudflarePlugin } from "./monitoring/CloudflarePlugin.js"
// import { createEwelinkPlugin } from "./monitoring/EwelinkPlugin.js"

// Export factory functions to create plugin instances.
// (Keys are display-only; the manager activates a plugin when its getName()
// lowercased matches an alias in the config `plugins` array.)
export default {
    PM2Plugin: createPM2Plugin,
    Docker: createDockerPlugin,
    Lxc: createLxcPlugin,
    OS: createOSPlugin,
    Website: createWebsitePlugin,
    Wordpress: createWordpressPlugin,
    Logwatch: createLogWatchPlugin,
    Netscan: createNetScanPlugin,
    Snmp: createSnmpPlugin,
    ThreeCX: createThreeCXPlugin,
    Tplink: createTplinkPlugin,
    // CloudflarePlugin: createCloudflarePlugin,
    // EwelinkPlugin: createEwelinkPlugin,
    // MongoDBPlugin: createMongoDBPlugin,
    // OSPlugin: createOSPlugin,
    // WebsitePlugin: createWebsitePlugin,
}
