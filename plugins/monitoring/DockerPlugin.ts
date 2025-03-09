import { MonitoringPlugin } from "../../lib/MonitoringPlugin.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface DockerConfig {
    containers?: string[];
    interval?: number;
}

interface DockerContainer {
    id: string;
    name: string;
    image: string;
    status: string;
    running: boolean;
    created: string;
    ports: string;
    cpu: number;
    memory: {
        usage: number;
        limit: number;
        percent: number;
    };
    restarts: number;
}

export class DockerPlugin extends MonitoringPlugin {
    private containers: DockerContainer[] = [];
    private containerNames: string[] = [];
    private interval: number = 60000; // Default interval: 1 minute
    private intervalId: NodeJS.Timeout | null = null;

    constructor(config: DockerConfig = {}) {
        super();
        this.containerNames = config.containers || [];
        this.interval = config.interval || 60000;
    }

    async setup(): Promise<void> {
        try {
            // Check if Docker is installed
            await execAsync("docker --version");
            
            // Initial check of containers
            await this.checkContainers();
            
            this.ready = true;
        } catch (error) {
            console.error("Docker plugin setup error:", error);
            this.ready = false;
        }
    }

    async monitor(): Promise<void> {
        if (!this.ready) {
            return;
        }

        try {
            // Start monitoring interval
            this.intervalId = setInterval(async () => {
                await this.checkContainers();
                
                // Send container data to the connector
                if (this.connector) {
                    this.connector.update({
                        type: "docker",
                        data: {
                            containers: this.containers,
                            timestamp: new Date()
                        }
                    });
                }
            }, this.interval);
        } catch (error) {
            console.error("Docker monitoring error:", error);
        }
    }

    async teardown(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private async checkContainers(): Promise<void> {
        try {
            // Get list of containers
            const { stdout: containerList } = await execAsync(
                "docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}'"
            );

            // Parse container list
            const containerIds: string[] = [];
            const parsedContainers: Partial<DockerContainer>[] = containerList
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const [id, name, image, status, ports, runningFor] = line.split('|');
                    
                    // Skip if containerNames is specified and this container is not in the list
                    if (this.containerNames.length > 0 && !this.containerNames.includes(name)) {
                        return null;
                    }
                    
                    containerIds.push(id);
                    
                    return {
                        id,
                        name,
                        image,
                        status,
                        running: status.toLowerCase().includes('up'),
                        ports,
                        created: runningFor
                    };
                })
                .filter(Boolean) as Partial<DockerContainer>[];

            // Get container stats (CPU, memory)
            for (const container of parsedContainers) {
                try {
                    const { stdout: stats } = await execAsync(
                        `docker stats ${container.id} --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.RestartCount}}'`
                    );
                    
                    const [cpuPerc, memUsage, memPerc, restarts] = stats.trim().split('|');
                    
                    // Parse memory usage (format: "100MiB / 1.952GiB")
                    const memoryParts = memUsage.split('/').map(part => part.trim());
                    const usage = this.parseMemoryValue(memoryParts[0]);
                    const limit = this.parseMemoryValue(memoryParts[1]);
                    
                    container.cpu = parseFloat(cpuPerc.replace('%', ''));
                    container.memory = {
                        usage,
                        limit,
                        percent: parseFloat(memPerc.replace('%', ''))
                    };
                    container.restarts = parseInt(restarts, 10);
                    
                } catch (statsError) {
                    console.error(`Error getting stats for container ${container.name}:`, statsError);
                }
            }

            this.containers = parsedContainers as DockerContainer[];
            
        } catch (error) {
            console.error("Error checking Docker containers:", error);
            throw error;
        }
    }
    
    private parseMemoryValue(value: string): number {
        // Convert memory values to bytes
        const unit = value.replace(/[0-9.]/g, '').trim().toUpperCase();
        const number = parseFloat(value.replace(/[^0-9.]/g, ''));
        
        switch (unit) {
            case 'B':
                return number;
            case 'KB':
            case 'KIB':
                return number * 1024;
            case 'MB':
            case 'MIB':
                return number * 1024 * 1024;
            case 'GB':
            case 'GIB':
                return number * 1024 * 1024 * 1024;
            case 'TB':
            case 'TIB':
                return number * 1024 * 1024 * 1024 * 1024;
            default:
                return number;
        }
    }
}