export class PluginConfigProvider {
    static config: any = {}

    /**
     * Load the full client config (the parsed client.config.json). Per-plugin
     * sections are keyed by alias (e.g. config.docker, config.pm2). Without this
     * the per-alias `get()` below always returns null and plugins silently fall
     * back to their hardcoded defaults.
     */
    static loadAll(config: any): void {
        PluginConfigProvider.config = config || {}
    }

    /** Synchronous lookup of a plugin's config section by alias. */
    static get(key: string): any {
        const section = PluginConfigProvider.config?.[key]
        return section == null ? null : section
    }
}
