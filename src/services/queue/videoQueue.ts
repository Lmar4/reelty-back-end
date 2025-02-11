import { PrismaClient, Prisma } from "@prisma/client";
import { ImageToVideoConverter } from "../imageProcessing/imageToVideoConverter";
import { logger } from "../../utils/logger";
import {
  SUBSCRIPTION_TIERS,
  SubscriptionTierId,
} from "../../constants/subscription-tiers";

export class VideoQueueService {
  private static instance: VideoQueueService;
  private prisma: PrismaClient;
  private imageToVideoConverter: ImageToVideoConverter;
  private processing: boolean = false;
  private maxConcurrentJobs: number = 10; // Default, can be adjusted based on Runway tier

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

    return await this.prisma.videoJob.create({
      data: {
        userId,
        listingId,
        inputFiles,
        template,
        status: "QUEUED",
        progress: 0,
      },
    });
  }

  private calculatePriority(basePriority: number, tierId?: string): number {
    // Higher tier subscribers get higher priority
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
        const activeJobs = await this.prisma.videoJob.count({
          where: {
            status: "PROCESSING",
          },
        });

        if (activeJobs >= this.maxConcurrentJobs) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        // Get next job from queue
        const nextJob = await this.prisma.videoJob.findFirst({
          where: { status: "QUEUED" },
          orderBy: { createdAt: "asc" },
        });

        if (!nextJob) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        // Process job
        await this.processJob(nextJob);
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
      // Update job status
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: "PROCESSING",
          progress: 0,
        },
      });

      // Process video
      const result = await this.imageToVideoConverter.convertImagesToVideo(
        job.inputFiles as string[],
        job.template
      );

      // Update job as completed
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          outputFile: result,
          progress: 100,
        },
      });
    } catch (error) {
      // Update job as failed
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Unknown error",
        },
      });

      logger.error("Video processing failed:", {
        jobId: job.id,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
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
}
