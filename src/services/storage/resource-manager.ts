import { promises as fs } from "fs";
import { logger } from "../../utils/logger";

export enum ResourceState {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  UPLOADED = "UPLOADED",
  FAILED = "FAILED",
}

interface ResourceEntry {
  path: string;
  state: ResourceState;
  type: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export class ResourceManager {
  private static instance: ResourceManager;
  private resources: Map<string, ResourceEntry> = new Map();
  private cleanupInProgress = false;

  private constructor() {}

  public static getInstance(): ResourceManager {
    if (!ResourceManager.instance) {
      ResourceManager.instance = new ResourceManager();
    }
    return ResourceManager.instance;
  }

  async trackResource(
    path: string,
    type: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    const now = new Date();
    this.resources.set(path, {
      path,
      state: ResourceState.PENDING,
      type,
      metadata,
      createdAt: now,
      updatedAt: now,
    });

    logger.debug("Resource tracked", { path, type, metadata });
  }

  async updateResourceState(
    path: string,
    state: ResourceState,
    metadata?: Record<string, any>
  ): Promise<void> {
    const resource = this.resources.get(path);
    if (!resource) {
      logger.warn("Attempted to update untracked resource", { path, state });
      return;
    }

    resource.state = state;
    resource.updatedAt = new Date();
    if (metadata) {
      resource.metadata = { ...resource.metadata, ...metadata };
    }

    this.resources.set(path, resource);
    logger.debug("Resource state updated", { path, state, metadata });
  }

  async cleanup(force = false): Promise<void> {
    if (this.cleanupInProgress) {
      logger.warn("Cleanup already in progress, skipping");
      return;
    }

    this.cleanupInProgress = true;
    const errors: Error[] = [];

    try {
      const resources = Array.from(this.resources.values());
      logger.info("Starting resource cleanup", {
        total: resources.length,
        force,
      });

      for (const resource of resources) {
        try {
          if (!force && resource.state !== ResourceState.UPLOADED) {
            logger.debug("Skipping cleanup of non-uploaded resource", {
              path: resource.path,
              state: resource.state,
            });
            continue;
          }

          // Check if file exists before attempting deletion
          try {
            await fs.access(resource.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              this.resources.delete(resource.path);
              continue;
            }
            throw error;
          }

          // Check if file is in use
          const isInUse = await this.isFileInUse(resource.path);
          if (isInUse && !force) {
            logger.warn("File appears to be in use, skipping cleanup", {
              path: resource.path,
            });
            continue;
          }

          await fs.unlink(resource.path);
          this.resources.delete(resource.path);

          logger.info("Resource cleaned up successfully", {
            path: resource.path,
            type: resource.type,
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);
          logger.error("Failed to cleanup resource", {
            path: resource.path,
            error: err.message,
          });
        }
      }

      if (errors.length > 0) {
        logger.warn("Some resources failed to cleanup", {
          failedCount: errors.length,
          totalCount: resources.length,
        });
      }
    } finally {
      this.cleanupInProgress = false;
    }
  }

  private async isFileInUse(filePath: string): Promise<boolean> {
    try {
      const handle = await fs.open(filePath, "r+");
      await handle.close();
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBUSY") {
        return true;
      }
      return false;
    }
  }

  getResourceState(path: string): ResourceState | undefined {
    return this.resources.get(path)?.state;
  }

  getResources(): ResourceEntry[] {
    return Array.from(this.resources.values());
  }

  getPendingResources(): ResourceEntry[] {
    return this.getResources().filter((r) => r.state === ResourceState.PENDING);
  }

  getProcessingResources(): ResourceEntry[] {
    return this.getResources().filter(
      (r) => r.state === ResourceState.PROCESSING
    );
  }
}

export const resourceManager = ResourceManager.getInstance();
