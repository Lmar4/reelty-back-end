import { PrismaClient } from "@prisma/client";
import { SUBSCRIPTION_TIERS } from "../../constants/subscription-tiers";
import { JobMetadata, JobProgress } from "../../types/job-types";
import { logger } from "../../utils/logger";
import { ImageToVideoConverter } from "../imageProcessing/imageToVideoConverter";

export class VideoQueueService {
  private static instance: VideoQueueService;
  private prisma: PrismaClient;
  private imageToVideoConverter: ImageToVideoConverter;
  private processing: boolean = false;
  private maxConcurrentJobs: number = 10;
  private runningJobs = new Map<string, boolean>();
  private jobStartTimes = new Map<string, number>();

  private constructor() {
    this.prisma = new PrismaClient();
    this.imageToVideoConverter = new ImageToVideoConverter(
      process.env.RUNWAYML_API_KEY || ""
    );
    this.startProcessing();
  }

  public static getInstance(): VideoQueueService {
    if (!VideoQueueService.instance) {
      VideoQueueService.instance = new VideoQueueService();
    }
    return VideoQueueService.instance;
  }

  private async canStartNewJob(): Promise<boolean> {
    const activeCount = await this.prisma.videoJob.count({
      where: { status: "PROCESSING" },
    });
    return activeCount < this.maxConcurrentJobs;
  }

  private async getNextJob(): Promise<any | null> {
    if (!(await this.canStartNewJob())) return null;

    return await this.prisma.videoJob.findFirst({
      where: {
        status: "QUEUED",
        NOT: {
          id: { in: Array.from(this.runningJobs.keys()) },
        },
      },
      orderBy: [
        { priority: "desc" }, // Higher priority jobs first
        { createdAt: "asc" }, // Older jobs first within same priority
      ],
      include: {
        listing: true,
        user: true,
      },
    });
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

  private async startProcessing(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (true) {
      try {
        const nextJob = await this.getNextJob();

        if (!nextJob) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        // Mark job as running and store start time
        this.runningJobs.set(nextJob.id, true);
        this.jobStartTimes.set(nextJob.id, Date.now());

        // Process job
        await this.processJob(nextJob);

        // Cleanup
        this.runningJobs.delete(nextJob.id);
        this.jobStartTimes.delete(nextJob.id);
      } catch (error) {
        logger.error("Queue processing error:", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
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
      const result = await this.imageToVideoConverter.convertImagesToVideo(
        job.inputFiles as string[],
        {
          ...job.template,
          coordinates:
            job.template === "googlezoomintro" ? coordinates : undefined,
        }
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
}
