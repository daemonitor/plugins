declare module "@daemonitor/plugins" {
    import { IConnector } from "@daemonitor/common"

    export abstract class PluginConfigProvider {
        static get(alias: string): any
    }

    export abstract class MonitoringPlugin extends BasePlugin {
        static currentPluginIndex: number
        protected instanceName: string
        protected refreshTimer: any
        protected uniqueId: string
        protected pluginIndex: number

        protected constructor(alias: string, name: string, description: string)

        public send(data: any, unique_id?: string): Promise<void>

        abstract setup(): Promise<void>;

        abstract monitor(): Promise<any>;

        abstract refresh(): Promise<void>;

        abstract teardown(): Promise<void>;

        getName(): string
    }


    export class PluginManager {

        constructor(configuredPlugins: any)

        static API_CONNECTIONS: IConnector[]

        initialize(): Promise<void>

        loadPlugins(): Promise<void>

        setupAll(): Promise<void>

        monitorAll(): Promise<any>

        addConnector(connector: IConnector): Promise<void>

        refreshAll(): Promise<void>

        teardownAll(): Promise<void>
    }

    export abstract class BasePlugin {
        static currentPluginIndex: number
        protected alias: string
        protected name: string
        protected description: string
        protected config: any

        protected constructor(alias: string, name: string, description: string)

        abstract setup(): Promise<void>;

        abstract monitor(): Promise<any>;

        abstract refresh(): Promise<void>;

        abstract teardown(): Promise<void>;

        getName(): string
    }
}
