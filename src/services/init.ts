import { registerServices } from "./registry/services.js";
import { logger } from "../utils/logger.js";
import { ServiceRegistry } from "./registry/service.registry.js";

/**
 * Initialize all services in the correct order
 */
export async function initializeServices(): Promise<void> {
  const registry = ServiceRegistry.getInstance();

  try {
    logger.info("Starting service registration");
    registerServices();
    logger.info("Service registration complete");

    logger.info("Starting service initialization");
    await registry.initialize();
    logger.info("Service initialization complete");

    // Log health status
    const health = await registry.getHealth();
    logger.info("Service health status:", health);
  } catch (error) {
    logger.error("Service initialization failed:", error);
    throw error;
  }
}

/**
 * Get service initialization status
 */
export function getServiceStatus(): Record<string, any> {
  const registry = ServiceRegistry.getInstance();
  return registry.getStatus();
}

/**
 * Get service health status
 */
export async function getServiceHealth(): Promise<Record<string, any>> {
  const registry = ServiceRegistry.getInstance();
  return registry.getHealth();
}
