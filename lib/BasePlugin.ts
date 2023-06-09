import { PluginConfigProvider } from "./PluginConfigProvider.js"

export abstract class BasePlugin {
    static currentPluginIndex = 0
    protected alias: string
    protected name: string
    protected description: string
     config: any

    protected constructor(alias: string, name: string, description: string) {
        this.config = PluginConfigProvider.get(alias)
        this.name = name
        this.description = description
    }

    abstract setup(): Promise<void>;

    abstract monitor(): Promise<any>;

    abstract refresh(): Promise<void>;

    abstract teardown(): Promise<void>;

    getName() {
        return this.name
    }
}
