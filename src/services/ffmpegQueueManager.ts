import { Semaphore } from "async-mutex";
import { logger } from "../utils/logger.js";
import * as crypto from "crypto";

/**
 * Centralized FFmpeg queue manager to enforce global concurrency limits
 * across all services that use FFmpeg (VideoProcessingService, ProductionPipeline, etc.)
 */
class FFmpegQueueManager {
  private static instance: FFmpegQueueManager;
  private semaphore: Semaphore;
  private readonly MAX_FFMPEG_JOBS = 1;
  private readonly DEFAULT_TIMEOUT = 120 * 1000; // Default 120s
  private readonly DEFAULT_MAX_RETRIES = 2; // Default 2 retries
  private activeJobs = 0;
  private queuedJobs = 0;

  private constructor() {
    this.semaphore = new Semaphore(this.MAX_FFMPEG_JOBS);
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
    const jobId = crypto.randomUUID();
    this.queuedJobs++;

    logger.info(`[${jobId}] Enqueuing FFmpeg job`, {
      maxConcurrentJobs: this.MAX_FFMPEG_JOBS,
      timeout,
      maxRetries,
      activeJobs: this.activeJobs,
      queuedJobs: this.queuedJobs,
    });

    return this.semaphore
      .runExclusive(async () => {
        this.activeJobs++;
        this.queuedJobs--;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          let timeoutId: NodeJS.Timeout | null = null;
          try {
            const memoryUsage = process.memoryUsage();
            logger.info(`[${jobId}] Starting FFmpeg job`, {
              attempt,
              maxRetries,
              activeJobs: this.activeJobs,
              queuedJobs: this.queuedJobs,
              memoryUsage: {
                rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
                heapTotal: `${Math.round(
                  memoryUsage.heapTotal / 1024 / 1024
                )} MB`,
                heapUsed: `${Math.round(
                  memoryUsage.heapUsed / 1024 / 1024
                )} MB`,
              },
            });

            timeoutId = setTimeout(() => {
              logger.error(
                `[${jobId}] FFmpeg job timed out after ${timeout}ms`,
                {
                  attempt,
                }
              );
              throw new Error(`FFmpeg job timed out after ${timeout}ms`);
            }, timeout);

            const result = await job();
            if (timeoutId) clearTimeout(timeoutId);
            logger.info(`[${jobId}] FFmpeg job completed`, {
              attempt,
              activeJobs: this.activeJobs,
              queuedJobs: this.queuedJobs,
            });
            return result;
          } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            logger.error(`[${jobId}] FFmpeg job failed`, {
              error: error instanceof Error ? error.message : "Unknown error",
              attempt,
              maxRetries,
              activeJobs: this.activeJobs,
              queuedJobs: this.queuedJobs,
            });

            if (attempt === maxRetries) throw error;

            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
            logger.info(`[${jobId}] Retrying in ${delay}ms`, { attempt });
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        throw new Error("Unreachable code"); // TypeScript safety
      })
      .finally(() => {
        this.activeJobs--;
        logger.debug(`[${jobId}] FFmpeg job finished`, {
          activeJobs: this.activeJobs,
          queuedJobs: this.queuedJobs,
        });
      });
  }

  public getActiveCount(): number {
    return this.activeJobs;
  }

  public getQueueLength(): number {
    return this.queuedJobs;
  }
}

export const ffmpegQueueManager = FFmpegQueueManager.getInstance();
