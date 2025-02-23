import { VideoService } from "../models/video.model.js";
import { ProcessedImageResult } from "../types/index.js";
import { logger } from "./logger.service.js";
import { s3Service } from "./storage/s3.service.js";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class PropertyService {
  constructor(private readonly videoService: VideoService) {}

  async processPropertyImages(
    propertyId: string,
    files: string[], // S3 URLs from frontend
    userId: string
  ): Promise<ProcessedImageResult[]> {
    // Early return if no files
    if (!files?.length) {
      return [];
    }

    try {
      const results = files.map((file) => ({
        originalPath: file,
        processedPath: file, // Frontend already provides WebP
        status: "completed" as const,
      }));

      // Create photos records with proper S3 key parsing
      await prisma.photo.createMany({
        data: files.map((file, index) => ({
          userId,
          listingId: propertyId,
          filePath: file,
          s3Key: s3Service.parseS3Url(file).key,
          status: "completed",
          order: index,
        })),
      });

      // Trigger video generation
      await this.videoService.createJob({
        userId,
        listingId: propertyId,
        inputFiles: files,
        metadata: {
          source: "property_upload",
        },
      });

      return results;
    } catch (error) {
      logger.error("Failed to process property images", {
        propertyId,
        userId,
        error,
      });
      throw error; // Propagate to caller
    }
  }
}
