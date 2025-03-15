import { logger } from "../../utils/logger.js";

type ServiceMetadata = {
  name: string;
  dependencies: string[];
  description: string;
};

export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private services: Map<string, any>;
  private metadata: Map<string, ServiceMetadata>;
  private initialized: boolean;

  private constructor() {
    this.services = new Map();
    this.metadata = new Map();
    this.initialized = false;
  }

  public static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  public register(service: any, metadata: ServiceMetadata): void {
    if (this.services.has(metadata.name)) {
      throw new Error(`Service ${metadata.name} is already registered`);
    }

    this.services.set(metadata.name, service);
    this.metadata.set(metadata.name, metadata);
    logger.info(`Registered service: ${metadata.name}`);
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const sortedServices = this.topologicalSort();

    for (const serviceName of sortedServices) {
      const service = this.services.get(serviceName);
      if (service && typeof service.initialize === "function") {
        logger.info(`Initializing service: ${serviceName}`);
        await service.initialize();
      }
    }

    this.initialized = true;
  }

  public getService(name: string): any {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service ${name} not found`);
    }
    return service;
  }

  public getStatus(): Record<string, any> {
    const status: Record<string, any> = {};
    this.services.forEach((service, name) => {
      status[name] = {
        initialized: this.initialized,
        dependencies: this.metadata.get(name)?.dependencies || [],
      };
    });
    return status;
  }

  public async getHealth(): Promise<Record<string, any>> {
    const health: Record<string, any> = {};
    for (const [name, service] of this.services.entries()) {
      health[name] = {
        status: "healthy",
        details:
          typeof service.getHealth === "function"
            ? await service.getHealth()
            : null,
      };
    }
    return health;
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const order: string[] = [];

    const visit = (serviceName: string) => {
      if (temp.has(serviceName)) {
        throw new Error(`Circular dependency detected: ${serviceName}`);
      }
      if (!visited.has(serviceName)) {
        temp.add(serviceName);
        const metadata = this.metadata.get(serviceName);
        if (metadata) {
          for (const dep of metadata.dependencies) {
            visit(dep);
          }
        }
        temp.delete(serviceName);
        visited.add(serviceName);
        order.push(serviceName);
      }
    };

    for (const serviceName of this.metadata.keys()) {
      if (!visited.has(serviceName)) {
        visit(serviceName);
      }
    }

    return order;
  }
}
