import { EwelinkPlugin } from "./monitoring/EwelinkPlugin.js"
import { OSPlugin } from "./monitoring/OSPlugin.js"
import { PM2Plugin } from "./monitoring/PM2Plugin.js"
import { MongoDBPlugin } from "./monitoring/MongoDBPlugin.js"
import { WebsitePlugin } from "./monitoring/WebsitePlugin.js"
import { DockerPlugin } from "./monitoring/DockerPlugin.js"
import { CloudflarePlugin } from "./monitoring/CloudflarePlugin.js"

export default {
    CloudflarePlugin,
    DockerPlugin,
    EwelinkPlugin,
    MongoDBPlugin,
    OSPlugin,
    PM2Plugin,
    WebsitePlugin
}
