// Import plugin factory functions
import { createPM2Plugin } from "./monitoring/PM2Plugin"
import { createDockerPlugin } from "./monitoring/DockerPlugin"
import { createLxcPlugin } from "./monitoring/LxcPlugin"
import { createOSPlugin } from "./monitoring/OSPlugin"
import { createWebsitePlugin } from "./monitoring/WebsitePlugin"
import { createWordpressPlugin } from "./monitoring/WordpressPlugin"
import { createLogWatchPlugin } from "./monitoring/LogWatchPlugin"
import { createNetScanPlugin } from "./monitoring/NetScanPlugin"
import { createSnmpPlugin } from "./monitoring/SnmpPlugin"

// In future, implement other plugin factory functions using the same pattern
// import { createOSPlugin } from "./monitoring/OSPlugin"
// import { createMongoDBPlugin } from "./monitoring/MongoDBPlugin"
// import { createWebsitePlugin } from "./monitoring/WebsitePlugin"
// import { createCloudflarePlugin } from "./monitoring/CloudflarePlugin"
// import { createEwelinkPlugin } from "./monitoring/EwelinkPlugin"

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
    // CloudflarePlugin: createCloudflarePlugin,
    // EwelinkPlugin: createEwelinkPlugin,
    // MongoDBPlugin: createMongoDBPlugin,
    // OSPlugin: createOSPlugin,
    // WebsitePlugin: createWebsitePlugin,
}
