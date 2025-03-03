import { logger } from "../utils/logger.js";
import * as crypto from "crypto";

/**
 * Centralized FFmpeg queue manager to enforce global concurrency limits
 * across all services that use FFmpeg (VideoProcessingService, ProductionPipeline, etc.)
 */
class FFmpegQueueManager {
  private static instance: FFmpegQueueManager;
  private activeFFmpegCount = 0;
  private readonly MAX_FFMPEG_JOBS = 1;
  private queue: Array<() => Promise<any>> = [];
  private processingLock = false;
  private readonly DEFAULT_TIMEOUT = 120 * 1000; // Default 120s
  private readonly DEFAULT_MAX_RETRIES = 2; // Default 2 retries

  private constructor() {
    logger.info("FFmpegQueueManager initialized", {
      maxConcurrentJobs: this.MAX_FFMPEG_JOBS,
    });
  }

  public static getInstance(): FFmpegQueueManager {
    if (!FFmpegQueueManager.instance) {
      FFmpegQueueManager.instance = new FFmpegQueueManager();
    }
    return FFmpegQueueManager.instance;
  }

  public async enqueueJob<T>(
    job: () => Promise<T>,
    timeout: number = this.DEFAULT_TIMEOUT,
    maxRetries: number = this.DEFAULT_MAX_RETRIES
  ): Promise<T> {
    const MAX_QUEUE_SIZE = 50;
    const jobId = crypto.randomUUID();

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      logger.error("FFmpeg queue full, rejecting job", {
        queueLength: this.queue.length,
        maxQueueSize: MAX_QUEUE_SIZE,
      });
      throw new Error("FFmpeg queue is full");
    }

    logger.info(`[${jobId}] Enqueuing FFmpeg job`, {
      activeJobs: this.activeFFmpegCount,
      queuedJobs: this.queue.length + 1,
      maxConcurrentJobs: this.MAX_FFMPEG_JOBS,
      timeout,
      maxRetries,
    });

    return new Promise<T>((resolve, reject) => {
      const wrappedJob = async () => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          let timeoutId: NodeJS.Timeout | null = null;
          try {
            this.activeFFmpegCount++;
            const memoryUsage = process.memoryUsage();
            logger.info(`[${jobId}] Starting FFmpeg job`, {
              activeJobs: this.activeFFmpegCount,
              queuedJobs: this.queue.length,
              memoryUsage: {
                rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
                heapTotal: `${Math.round(
                  memoryUsage.heapTotal / 1024 / 1024
                )} MB`,
                heapUsed: `${Math.round(
                  memoryUsage.heapUsed / 1024 / 1024
                )} MB`,
              },
              attempt,
              maxRetries,
            });

            timeoutId = setTimeout(() => {
              logger.error(
                `[${jobId}] FFmpeg job timed out after ${timeout}ms`,
                {
                  attempt,
                }
              );
              reject(new Error(`FFmpeg job timed out after ${timeout}ms`));
            }, timeout);

            const result = await job();
            if (timeoutId) clearTimeout(timeoutId);
            logger.info(`[${jobId}] FFmpeg job completed`, {
              activeJobs: this.activeFFmpegCount,
              attempt,
            });
            resolve(result);
            return result;
          } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            logger.error(`[${jobId}] FFmpeg job failed`, {
              error: error instanceof Error ? error.message : "Unknown error",
              activeJobs: this.activeFFmpegCount,
              queuedJobs: this.queue.length,
              attempt,
              maxRetries,
            });

            if (attempt === maxRetries) {
              reject(error);
              throw error;
            }

            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
            logger.info(`[${jobId}] Retrying in ${delay}ms`, { attempt });
            await new Promise((r) => setTimeout(r, delay));
          } finally {
            this.activeFFmpegCount--;
            logger.debug(`[${jobId}] FFmpeg job finished`, {
              activeJobs: this.activeFFmpegCount,
              queuedJobs: this.queue.length,
            });
          }
        }
      };

      this.queue.push(wrappedJob);

      if (
        !this.processingLock &&
        this.activeFFmpegCount < this.MAX_FFMPEG_JOBS
      ) {
        logger.debug(`[${jobId}] Triggering queue processing`, {
          activeJobs: this.activeFFmpegCount,
          queuedJobs: this.queue.length,
        });
        setTimeout(() => this.processQueue(), 0);
      }
    });
  }

  private async processQueue() {
    if (this.processingLock) return;

    this.processingLock = true;
    const queueId = crypto.randomUUID().substring(0, 8);

    logger.debug(`[Queue-${queueId}] Processing FFmpeg queue`, {
      queueLength: this.queue.length,
      activeJobs: this.activeFFmpegCount,
      maxConcurrentJobs: this.MAX_FFMPEG_JOBS,
    });

    try {
      while (
        this.queue.length > 0 &&
        this.activeFFmpegCount < this.MAX_FFMPEG_JOBS
      ) {
        const job = this.queue.shift();
        if (job) {
          try {
            await job();
          } catch (error) {
            // Error already handled in the job wrapper
            logger.error(
              `[Queue-${queueId}] FFmpeg job failed in queue processor`,
              {
                error: error instanceof Error ? error.message : "Unknown error",
                activeJobs: this.activeFFmpegCount,
                queueLength: this.queue.length,
              }
            );
          }
        }
      }
    } finally {
      this.processingLock = false;

      logger.debug(`[Queue-${queueId}] Queue processing completed`, {
        remainingJobs: this.queue.length,
        activeJobs: this.activeFFmpegCount,
      });

      // If there are still jobs and we're not at capacity, continue processing
      if (
        this.queue.length > 0 &&
        this.activeFFmpegCount < this.MAX_FFMPEG_JOBS
      ) {
        setTimeout(() => this.processQueue(), 100);
      }
    }
  }

  public getActiveCount(): number {
    return this.activeFFmpegCount;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

export const ffmpegQueueManager = FFmpegQueueManager.getInstance();
