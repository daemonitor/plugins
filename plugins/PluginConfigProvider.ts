class PluginConfigProvider {
    static config: any = {}
    static async get(key: string): Promise<any> {
        if (!PluginConfigProvider.config[key]) {
            return null
        }
        return PluginConfigProvider.config[key]
    }

    // static async loadConfig(): Promise<void> {
    //     if (!ConfigProvider.config) {
    //         const configPath = path.join(__dirname, "config.json")
    //         return await fs.readFile(configPath, "utf8").then((data) => {
    //             ConfigProvider.config = JSON.parse(data)
    //         })
    //     }
    // }
}

export default PluginConfigProvider
