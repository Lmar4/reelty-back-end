import { PrismaClient } from "@prisma/client";
import { SUBSCRIPTION_TIERS } from "../../constants/subscription-tiers";
import { JobMetadata, JobProgress } from "../../types/job-types";
import { logger } from "../../utils/logger";
import { ImageToVideoConverter } from "../imageProcessing/imageToVideoConverter";
import { TemplateKey } from "../imageProcessing/templates/types";
import { mapCaptureService } from "../map-capture/map-capture.service";

interface QueuedUpload {
  listingId: string;
  files: string[];
  priority: number;
  timestamp: Date;
  userId: string;
  template: string;
}

export class VideoQueueService {
  private static instance: VideoQueueService;
  private prisma: PrismaClient;
  private imageToVideoConverter: ImageToVideoConverter;
  private processing: boolean = false;
  private maxConcurrentJobs: number = 3;
  private processId: string;
  private jobStartTimes = new Map<string, number>();
  private readonly LOCK_TIMEOUT = 1000 * 60 * 30; // 30 minutes
  private readonly CLEANUP_INTERVAL = 1000 * 60 * 5; // 5 minutes
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // 1 second

  private constructor() {
    this.prisma = new PrismaClient();
    this.imageToVideoConverter = ImageToVideoConverter.getInstance();
    this.processId = `process_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    this.startProcessing();
    setInterval(() => this.cleanupExpiredLocks(), this.CLEANUP_INTERVAL);
  }

  public static getInstance(): VideoQueueService {
    if (!VideoQueueService.instance) {
      VideoQueueService.instance = new VideoQueueService();
    }
    return VideoQueueService.instance;
  }

  private async cleanupExpiredLocks(): Promise<void> {
    try {
      await this.prisma.listingLock.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(),
          },
        },
      });
    } catch (error) {
      logger.error("Failed to cleanup expired locks:", error);
    }
  }

  private async acquireListingLock(
    listingId: string,
    jobId: string
  ): Promise<boolean> {
    let retries = 0;
    while (retries < this.MAX_RETRIES) {
      try {
        await this.cleanupExpiredLocks();

        // Try to acquire the lock using a transaction
        await this.prisma.$transaction(async (tx) => {
          const existingLock = await tx.listingLock.findUnique({
            where: { listingId },
          });

          if (existingLock) {
            if (existingLock.expiresAt < new Date()) {
              // Lock has expired, we can take it
              await tx.listingLock.update({
                where: { listingId },
                data: {
                  jobId,
                  processId: this.processId,
                  expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
                  updatedAt: new Date(),
                },
              });
            } else {
              throw new Error("Lock is held by another process");
            }
          } else {
            // Create new lock
            await tx.listingLock.create({
              data: {
                listingId,
                jobId,
                processId: this.processId,
                expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
              },
            });
          }
        });

        return true;
      } catch (error) {
        retries++;
        if (retries >= this.MAX_RETRIES) {
          logger.error("Failed to acquire listing lock after max retries:", {
            listingId,
            jobId,
            error,
          });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY));
      }
    }

    return false;
  }

  private async releaseLock(listingId: string): Promise<void> {
    try {
      await this.prisma.listingLock.deleteMany({
        where: {
          listingId,
          processId: this.processId,
        },
      });
    } catch (error) {
      logger.error("Error releasing listing lock:", {
        listingId,
        error,
      });
    }
  }

  private async consolidateJobs(listingId: string): Promise<string> {
    const pendingJobs = await this.prisma.videoJob.findMany({
      where: {
        listingId,
        status: { in: ["QUEUED", "PROCESSING"] },
      },
      orderBy: { createdAt: "asc" },
    });

    if (pendingJobs.length <= 1) return pendingJobs[0]?.id;

    // Merge all input files and keep highest priority
    const allFiles = new Set<string>();
    let maxPriority = 1;
    let template = pendingJobs[0].template;

    pendingJobs.forEach((job) => {
      maxPriority = Math.max(maxPriority, job.priority);
      if (job.inputFiles) {
        (job.inputFiles as string[]).forEach((file) => allFiles.add(file));
      }
      // Keep the most recent template if different
      if (job.template) {
        template = job.template;
      }
    });

    // Create consolidated job
    const consolidatedJob = await this.prisma.videoJob.create({
      data: {
        listingId,
        userId: pendingJobs[0].userId,
        inputFiles: Array.from(allFiles),
        template,
        priority: maxPriority,
        status: "QUEUED",
        metadata: {
          consolidatedFrom: pendingJobs.map((j) => j.id),
          originalCount: pendingJobs.length,
        },
      },
    });

    // Cancel old jobs
    await this.prisma.videoJob.updateMany({
      where: { id: { in: pendingJobs.map((j) => j.id) } },
      data: {
        status: "CANCELLED",
        metadata: {
          consolidatedInto: consolidatedJob.id,
        },
      },
    });

    logger.info("Consolidated jobs:", {
      listingId,
      oldJobs: pendingJobs.map((j) => j.id),
      newJobId: consolidatedJob.id,
    });

    return consolidatedJob.id;
  }

  private async processNextInQueue(): Promise<void> {
    const nextJob = await this.prisma.videoJob.findFirst({
      where: {
        status: "QUEUED",
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });

    if (!nextJob) return;

    // Try to acquire lock
    const lockAcquired = await this.acquireListingLock(
      nextJob.listingId,
      nextJob.id
    );

    if (!lockAcquired) {
      logger.info("Skipping job due to listing lock:", {
        jobId: nextJob.id,
        listingId: nextJob.listingId,
      });
      return;
    }

    try {
      // Consolidate any other pending jobs for this listing
      const consolidatedJobId = await this.consolidateJobs(nextJob.listingId);
      const jobToProcess =
        consolidatedJobId === nextJob.id
          ? nextJob
          : await this.prisma.videoJob.findUnique({
              where: { id: consolidatedJobId },
            });

      if (!jobToProcess) {
        throw new Error("Job not found after consolidation");
      }

      // Process the job
      await this.processJob(jobToProcess);
    } finally {
      await this.releaseLock(nextJob.listingId);
    }
  }

  private async startProcessing(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (true) {
      try {
        await this.processNextInQueue();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error("Error in queue processing:", error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private calculateEstimatedTime(
    stage: JobProgress["stage"],
    filesRemaining: number
  ): number {
    const timePerFile: Record<JobProgress["stage"], number> = {
      webp: 5, // 5 seconds per file for WebP conversion
      runway: 30, // 30 seconds per file for Runway processing
      template: 15, // 15 seconds per file for template processing
      final: 20, // 20 seconds for final video creation
    };

    return filesRemaining * timePerFile[stage];
  }

  async updateJobProgress(jobId: string, progress: JobProgress): Promise<void> {
    try {
      const startTime = this.jobStartTimes.get(jobId);
      const now = Date.now();
      const metadata: JobMetadata = {
        stage: progress.stage,
        currentFile: progress.currentFile,
        totalFiles: progress.totalFiles,
        estimatedTimeRemaining: this.calculateEstimatedTime(
          progress.stage,
          progress.totalFiles - progress.currentFile
        ),
        startTime: startTime ? new Date(startTime).toISOString() : undefined,
      };

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: "PROCESSING",
          progress: progress.progress,
          metadata: metadata as any, // Prisma will handle JSON serialization
        },
      });

      logger.info("Job progress updated", {
        jobId,
        progress,
        metadata,
      });
    } catch (error) {
      logger.error("Failed to update job progress", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async enqueueJob(input: {
    userId: string;
    listingId: string;
    inputFiles: string[];
    template: string;
    priority?: number;
  }) {
    const { userId, listingId, inputFiles, template, priority = 1 } = input;

    // Check for existing active jobs for this listing
    const existingJob = await this.prisma.videoJob.findFirst({
      where: {
        listingId,
        status: { in: ["QUEUED", "PROCESSING"] },
      },
    });

    if (existingJob) {
      logger.info("Found existing job for listing", {
        listingId,
        existingJobId: existingJob.id,
      });
      return existingJob;
    }

    // Get user's subscription tier to determine priority
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { currentTier: true },
    });

    // Adjust priority based on subscription tier
    const adjustedPriority = this.calculatePriority(
      priority,
      user?.currentTierId || undefined
    );

    const job = await this.prisma.videoJob.create({
      data: {
        userId,
        listingId,
        inputFiles,
        template,
        status: "QUEUED",
        progress: 0,
        priority: adjustedPriority,
        metadata: {
          stage: "webp",
          currentFile: 0,
          totalFiles: inputFiles.length,
          startTime: new Date().toISOString(),
        } as any,
      },
    });

    logger.info("Job enqueued", {
      jobId: job.id,
      userId,
      listingId,
      priority: adjustedPriority,
    });

    return job;
  }

  private calculatePriority(basePriority: number, tierId?: string): number {
    const tierMultiplier: Record<string, number> = {
      [SUBSCRIPTION_TIERS.BASIC]: 1,
      [SUBSCRIPTION_TIERS.PRO]: 2,
      [SUBSCRIPTION_TIERS.ENTERPRISE]: 3,
      [SUBSCRIPTION_TIERS.AGENCY]: 4,
    };

    return (
      basePriority * (tierMultiplier[tierId || SUBSCRIPTION_TIERS.BASIC] || 1)
    );
  }

  private async processJob(job: any): Promise<void> {
    try {
      // Set job as started
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: "PROCESSING",
          startedAt: new Date(),
        },
      });

      // Get listing details for coordinates
      const listing = await this.prisma.listing.findUnique({
        where: { id: job.listingId },
      });

      if (!listing) {
        throw new Error("Listing not found");
      }

      // Extract coordinates from listing
      const coordinates = listing.coordinates
        ? JSON.parse(listing.coordinates as string)
        : null;

      // Update initial job status
      await this.updateJobProgress(job.id, {
        stage: "webp",
        progress: 0,
        currentFile: 0,
        totalFiles: job.inputFiles.length,
      });

      // Process WebP conversion
      for (let i = 0; i < job.inputFiles.length; i++) {
        await this.updateJobProgress(job.id, {
          stage: "webp",
          progress: Math.round((i / job.inputFiles.length) * 25),
          currentFile: i + 1,
          totalFiles: job.inputFiles.length,
        });
      }

      // Process Runway video generation
      for (let i = 0; i < job.inputFiles.length; i++) {
        await this.updateJobProgress(job.id, {
          stage: "runway",
          progress: 25 + Math.round((i / job.inputFiles.length) * 50),
          currentFile: i + 1,
          totalFiles: job.inputFiles.length,
        });
      }

      // Process template
      await this.updateJobProgress(job.id, {
        stage: "template",
        progress: 75,
        currentFile: 1,
        totalFiles: 1,
      });

      // Process video with coordinates if needed
      const result = await this.imageToVideoConverter.createTemplate(
        job.template as TemplateKey,
        job.inputFiles,
        job.template === "googlezoomintro" && coordinates
          ? await this.createMapVideo(coordinates)
          : undefined
      );

      // Final processing
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          progress: 100,
          outputFile: result,
          completedAt: new Date(),
        },
      });

      logger.info("Job completed successfully", {
        jobId: job.id,
        duration: Date.now() - (this.jobStartTimes.get(job.id) || Date.now()),
      });
    } catch (error) {
      logger.error("Video processing failed:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Update job as failed
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });
    }
  }

  async getQueueStatus(userId: string) {
    return await this.prisma.videoJob.findMany({
      where: {
        userId,
        status: {
          in: ["QUEUED", "PROCESSING"],
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async getJobProgress(jobId: string) {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new Error("Job not found");
    }

    return {
      status: job.status,
      progress: job.progress,
      metadata: job.metadata,
    };
  }

  private async createMapVideo(coordinates: any): Promise<string> {
    try {
      // Create map frames
      const framesDir = await mapCaptureService.captureMapFrames(coordinates);

      // Create video from frames
      const outputPath = await mapCaptureService.createVideo(framesDir);

      return outputPath;
    } catch (error) {
      logger.error("Failed to create map video:", {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
      });
      throw error;
    }
  }
}
