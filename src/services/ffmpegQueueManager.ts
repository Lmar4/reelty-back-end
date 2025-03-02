import { logger } from "../utils/logger.js";
import * as crypto from "crypto";

/**
 * Centralized FFmpeg queue manager to enforce global concurrency limits
 * across all services that use FFmpeg (VideoProcessingService, ProductionPipeline, etc.)
 */
class FFmpegQueueManager {
  private static instance: FFmpegQueueManager;
  private activeFFmpegCount = 0;
  private readonly MAX_FFMPEG_JOBS = 1; // Conservative limit for testing
  private queue: Array<() => Promise<any>> = []; // Use any to accommodate different return types
  private processingLock = false;

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

  public async enqueueJob<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const MAX_QUEUE_SIZE = 50;
      const JOB_TIMEOUT = 120 * 1000;

      if (this.queue.length >= MAX_QUEUE_SIZE) {
        logger.error("FFmpeg queue full, rejecting job", {
          queueLength: this.queue.length,
          maxQueueSize: MAX_QUEUE_SIZE,
        });
        reject(new Error("FFmpeg queue is full"));
        return;
      }

      const jobId = crypto.randomUUID();
      logger.info(`[${jobId}] Enqueuing FFmpeg job`, {
        activeJobs: this.activeFFmpegCount,
        queuedJobs: this.queue.length + 1,
        maxConcurrentJobs: this.MAX_FFMPEG_JOBS,
      });

      this.queue.push(async () => {
        let timeoutId: NodeJS.Timeout | null = null;
        try {
          // Wait for an available slot
          while (this.activeFFmpegCount >= this.MAX_FFMPEG_JOBS) {
            await new Promise((r) => setTimeout(r, 100));
          }

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
              heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
            },
          });

          timeoutId = setTimeout(() => {
            logger.error(
              `[${jobId}] FFmpeg job timed out after ${JOB_TIMEOUT}ms`
            );
            reject(new Error(`FFmpeg job timed out after ${JOB_TIMEOUT}ms`));
          }, JOB_TIMEOUT);

          const result = await job();
          if (timeoutId) clearTimeout(timeoutId);
          logger.info(`[${jobId}] FFmpeg job completed`, {
            activeJobs: this.activeFFmpegCount,
          });
          resolve(result);
          return result;
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);
          logger.error(`[${jobId}] FFmpeg job failed`, {
            error: error instanceof Error ? error.message : "Unknown error",
            activeJobs: this.activeFFmpegCount,
            queuedJobs: this.queue.length,
          });
          reject(error);
          throw error;
        } finally {
          this.activeFFmpegCount--;
          logger.debug(`[${jobId}] FFmpeg job finished`, {
            activeJobs: this.activeFFmpegCount,
            queuedJobs: this.queue.length,
          });
          if (this.queue.length > 0) {
            setTimeout(() => this.processQueue(), 100);
          }
        }
      });

      if (!this.processingLock) {
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
