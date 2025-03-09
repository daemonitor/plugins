import { MonitoringPlugin } from "../../lib/MonitoringPlugin.js"

/**
 * CloudflarePlugin - Receives push updates from Cloudflare Workers
 * 
 * This plugin receives data directly from a client's Cloudflare Worker
 * rather than polling for it. The plugin sets up a monitoring endpoint,
 * and the Cloudflare Worker pushes data to this endpoint on a schedule.
 */
export class CloudflarePlugin extends MonitoringPlugin {
    private lastReportedData: any = null;
    private lastReportTime: number = 0;
    private reportingKey: string;
    private maxDataAge: number;

    constructor() {
        super("cloudflare", "Cloudflare", "Cloudflare Deployment Monitoring Plugin (Push Mode)")
        this.reportingKey = this.config.reportingKey;
        this.maxDataAge = this.config.maxDataAge || 5 * 60 * 1000; // Default 5 minutes
    }

    async setup(): Promise<void> {
        if (!this.reportingKey) {
            console.error("Cloudflare reporting key not provided");
            return Promise.reject("Reporting key not provided");
        }
        
        // Register this instance to receive push updates
        try {
            // Normally this would make an API call to register this plugin instance
            // to receive push updates from Cloudflare Workers with this reporting key
            console.log(`Cloudflare plugin ready to receive push updates for key: ${this.reportingKey}`);
            
            return Promise.resolve();
        } catch (error) {
            console.error("Failed to register for Cloudflare push updates:", error);
            return Promise.reject("Registration failed");
        }
    }

    /**
     * This method is called when data is pushed from a Cloudflare Worker
     * It would typically be called by a webhook or socket connection
     */
    public async receiveUpdate(data: any, key: string): Promise<void> {
        // Verify the reporting key matches
        if (key !== this.reportingKey) {
            console.error("Invalid reporting key for Cloudflare update");
            return;
        }

        this.lastReportedData = {
            ...data,
            receivedAt: Date.now()
        };
        this.lastReportTime = Date.now();
        
        // Forward the data to the monitoring system
        await this.send({
            ...data,
            timestamp: Date.now(),
            status: "ok"
        });
    }

    // This method checks if data is still fresh
    async refresh(): Promise<void> {
        const now = Date.now();
        const dataAge = now - this.lastReportTime;
        
        // If we have data and it's still fresh, do nothing
        if (this.lastReportedData && dataAge < this.maxDataAge) {
            return;
        }
        
        // If data is stale or doesn't exist, report error status
        await this.send({
            timestamp: now,
            error: `No data received in the last ${dataAge / 60000} minutes`,
            status: "error",
            lastReportTime: this.lastReportTime
        });
    }

    async monitor(): Promise<any> {
        // Set up interval just to check for stale data
        this.refreshTimer = setInterval(
            this.refresh.bind(this), 
            this.config.refreshInterval || 60000 // Default to 1 minute
        );
    }

    async teardown(): Promise<void> {
        // Unregister from receiving push updates
        clearInterval(this.refreshTimer);
        return Promise.resolve();
    }
}