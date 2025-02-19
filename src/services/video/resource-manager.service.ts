import fs from "fs/promises";
import path from "path";
import { logger } from "../../utils/logger";

class ResourceManagerService {
  private resources: Map<string, string[]>;
  private tempDir: string;

  constructor() {
    this.resources = new Map();
    this.tempDir = path.join(process.cwd(), "temp");
  }

  public async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      logger.info("Resource manager initialized");
    } catch (error) {
      logger.error("Failed to initialize resource manager:", error);
      throw error;
    }
  }

  public trackResource(jobId: string, resourcePath: string): void {
    const resources = this.resources.get(jobId) || [];
    resources.push(resourcePath);
    this.resources.set(jobId, resources);
    logger.debug(`Tracked resource for job ${jobId}: ${resourcePath}`);
  }

  public async cleanup(jobId: string): Promise<void> {
    const resources = this.resources.get(jobId) || [];
    const errors: Error[] = [];

    for (const resource of resources) {
      try {
        await fs.unlink(resource);
        logger.debug(`Cleaned up resource: ${resource}`);
      } catch (error) {
        logger.error(`Failed to cleanup resource ${resource}:`, error);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.resources.delete(jobId);

    if (errors.length > 0) {
      logger.warn(
        `Cleanup completed with ${errors.length} errors for job ${jobId}`
      );
    } else {
      logger.info(`Cleanup completed successfully for job ${jobId}`);
    }
  }

  public async getHealth(): Promise<Record<string, any>> {
    try {
      const stats = await fs.stat(this.tempDir);
      return {
        tempDir: {
          exists: true,
          path: this.tempDir,
          isDirectory: stats.isDirectory(),
        },
      };
    } catch (error) {
      return {
        tempDir: {
          exists: false,
          path: this.tempDir,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }
}

export const resourceManager = new ResourceManagerService();
