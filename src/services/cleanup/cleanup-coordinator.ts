import { logger } from "../../utils/logger";
import { ResourceManager, ResourceState } from "../storage/resource-manager";
import { S3VideoService } from "../video/s3-video.service";
import { promises as fs } from "fs";

interface CleanupTask {
  path: string;
  type: "file" | "s3" | "directory";
  cleanup: () => Promise<void>;
  metadata?: Record<string, any>;
  priority?: number;
  retries?: number;
}

export class CleanupCoordinator {
  private static instance: CleanupCoordinator;
  private queue: Map<string, CleanupTask> = new Map();
  private isProcessing = false;
  private readonly MAX_RETRIES = 3;
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_TIMEOUT = 30 * 1000; // 30 seconds per task
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor(
    private readonly resourceManager: ResourceManager,
    private readonly s3VideoService: S3VideoService
  ) {
    this.startPeriodicCleanup();
  }

  public static getInstance(): CleanupCoordinator {
    if (!CleanupCoordinator.instance) {
      CleanupCoordinator.instance = new CleanupCoordinator(
        ResourceManager.getInstance(),
        S3VideoService.getInstance()
      );
    }
    return CleanupCoordinator.instance;
  }

  private startPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(() => {
      this.executeCleanup().catch((error) => {
        logger.error("Periodic cleanup failed", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    }, this.CLEANUP_INTERVAL);
  }

  public async register(
    path: string,
    options: {
      type: "file" | "s3" | "directory";
      metadata?: Record<string, any>;
      priority?: number;
      customCleanup?: () => Promise<void>;
    }
  ): Promise<void> {
    const { type, metadata, priority = 0, customCleanup } = options;

    let cleanup: () => Promise<void>;
    if (customCleanup) {
      cleanup = customCleanup;
    } else {
      switch (type) {
        case "file":
          cleanup = async () => {
            try {
              await fs.access(path);
              await fs.unlink(path);
              logger.info("File cleaned up", { path });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
            }
          };
          break;
        case "directory":
          cleanup = async () => {
            try {
              await fs.rm(path, { recursive: true, force: true });
              logger.info("Directory cleaned up", { path });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
            }
          };
          break;
        case "s3":
          cleanup = async () => {
            const { bucket, key } = this.s3VideoService.parseS3Path(path);
            await this.s3VideoService.checkFileExists(bucket, key);
            // File exists, proceed with deletion
            await this.s3VideoService.deleteFile(bucket, key);
            logger.info("S3 object cleaned up", { path, bucket, key });
          };
          break;
        default:
          throw new Error(`Unsupported cleanup type: ${type}`);
      }
    }

    this.queue.set(path, {
      path,
      type,
      cleanup,
      metadata,
      priority,
      retries: 0,
    });

    logger.debug("Cleanup task registered", {
      path,
      type,
      metadata,
      priority,
      queueSize: this.queue.size,
    });
  }

  public async executeCleanup(force = false): Promise<void> {
    if (this.isProcessing && !force) {
      logger.warn("Cleanup already in progress");
      return;
    }

    this.isProcessing = true;
    const errors: Error[] = [];

    try {
      // Sort tasks by priority (higher numbers first)
      const sortedTasks = Array.from(this.queue.values()).sort(
        (a, b) => (b.priority || 0) - (a.priority || 0)
      );

      for (const task of sortedTasks) {
        try {
          // Skip if resource is still in use
          const resourceState = this.resourceManager.getResourceState(
            task.path
          );
          if (
            !force &&
            resourceState &&
            resourceState !== ResourceState.UPLOADED
          ) {
            logger.debug("Skipping cleanup of in-use resource", {
              path: task.path,
              state: resourceState,
            });
            continue;
          }

          // Execute cleanup with timeout
          await Promise.race([
            task.cleanup(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Cleanup timeout")),
                this.MAX_TIMEOUT
              )
            ),
          ]);

          // Successful cleanup
          this.queue.delete(task.path);
          logger.info("Cleanup task completed", {
            path: task.path,
            type: task.type,
          });
        } catch (error) {
          const retries = (task.retries || 0) + 1;
          if (retries < this.MAX_RETRIES) {
            // Update retry count and keep in queue
            this.queue.set(task.path, { ...task, retries });
            logger.warn("Cleanup task failed, will retry", {
              path: task.path,
              error: error instanceof Error ? error.message : "Unknown error",
              attempt: retries,
            });
          } else {
            // Max retries reached, remove from queue
            this.queue.delete(task.path);
            const err =
              error instanceof Error ? error : new Error(String(error));
            errors.push(err);
            logger.error("Cleanup task failed permanently", {
              path: task.path,
              error: err.message,
            });
          }
        }
      }

      if (errors.length > 0) {
        logger.warn("Some cleanup tasks failed", {
          failedCount: errors.length,
          totalTasks: sortedTasks.length,
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public getQueueSize(): number {
    return this.queue.size;
  }

  public getPendingTasks(): CleanupTask[] {
    return Array.from(this.queue.values());
  }

  public async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const cleanupCoordinator = CleanupCoordinator.getInstance();
