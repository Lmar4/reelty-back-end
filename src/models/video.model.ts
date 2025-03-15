import { logger } from "../services/logger.service.js";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline.js";
import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { TemplateKey } from "../services/imageProcessing/templates/types.js";

const prisma = new PrismaClient();

export interface VideoJobInput {
  userId: string;
  listingId: string;
  template?: string;
  inputFiles: string[]; // S3 URLs from frontend
  metadata?: Record<string, any>;
  priority?: number;
}

export interface VideoJobResponse {
  id: string;
  userId: string;
  listingId: string;
  status: VideoGenerationStatus;
  template: string | null;
  inputFiles: string[];
  outputFile: string | null;
  thumbnailUrl: string | null;
  metadata: Record<string, any> | null;
  error: string | null;
  position: number;
  priority: number;
  progress: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
          priority: input.priority || 1,
        },
      });

      // Start processing immediately
      this.productionPipeline
        .execute({
          jobId: job.id,
          inputFiles: input.inputFiles,
          template: input.template as TemplateKey,
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
