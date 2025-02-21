import { logger } from "../services/logger.service";
import { ProductionPipeline } from "../services/video/production-pipeline";
import { PrismaClient, VideoGenerationStatus } from "@prisma/client";

const prisma = new PrismaClient();

export interface VideoJobInput {
  userId: string;
  listingId: string;
  template?: string;
  inputFiles: string[]; // S3 URLs from frontend
  metadata?: Record<string, any>;
}

export class VideoService {
  constructor(private readonly productionPipeline: ProductionPipeline) {}

  async createJob(input: VideoJobInput) {
    try {
      const job = await prisma.videoJob.create({
        data: {
          userId: input.userId,
          listingId: input.listingId,
          status: VideoGenerationStatus.PENDING,
          template: input.template,
          inputFiles: input.inputFiles,
          metadata: input.metadata || {},
          position: 0,
          priority: 1,
        },
      });

      // Start processing immediately
      this.productionPipeline
        .execute({
          jobId: job.id,
          inputFiles: input.inputFiles,
          template: input.template || "default",
        })
        .catch((error) => {
          logger.error("Failed to execute production pipeline", {
            jobId: job.id,
            userId: input.userId,
            error,
          });
        });

      return job;
    } catch (error) {
      logger.error("Failed to create video job", {
        userId: input.userId,
        listingId: input.listingId,
        error,
      });
      throw error;
    }
  }
}
