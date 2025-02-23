import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { logger } from "../../utils/logger.js";

class ProgressTrackerService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  public async updateProgress(
    jobId: string,
    progress: number,
    stage?: string,
    status?: VideoGenerationStatus
  ): Promise<void> {
    try {
      const updateData: any = {
        progress: Math.min(Math.max(progress, 0), 100),
      };

      if (status) {
        updateData.status = status;
      }

      if (stage) {
        updateData.metadata = {
          currentStage: stage,
        };
      }

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: updateData,
      });

      logger.debug(
        `Updated job ${jobId} progress: ${progress}%${
          stage ? ` (${stage})` : ""
        }`
      );
    } catch (error) {
      logger.error(`Failed to update progress for job ${jobId}:`, error);
    }
  }

  public async initialize(): Promise<void> {
    // Initialization logic if needed
    logger.info("Progress tracker service initialized");
  }

  public async getHealth(): Promise<Record<string, any>> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { database: "connected" };
    } catch (error) {
      return {
        database: "disconnected",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

export const progressTracker = new ProgressTrackerService();
