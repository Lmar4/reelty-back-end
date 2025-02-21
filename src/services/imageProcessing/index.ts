import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { StorageService } from "../storage";
import { ProductionPipeline } from "../imageProcessing/productionPipeline";
import { TemplateKey } from "../imageProcessing/templates/types";
import { logger } from "../../utils/logger";

const prisma = new PrismaClient();

export class ImageProcessingService {
  private static instance: ImageProcessingService;
  private readonly storageService: StorageService;
  private readonly productionPipeline: ProductionPipeline;

  private constructor() {
    this.storageService = StorageService.getInstance();
    this.productionPipeline = new ProductionPipeline();
  }

  public static getInstance(): ImageProcessingService {
    if (!ImageProcessingService.instance) {
      ImageProcessingService.instance = new ImageProcessingService();
    }
    return ImageProcessingService.instance;
  }

  async processPropertyImages(
    propertyId: string,
    files: string[] // S3 URLs from frontend
  ): Promise<
    Array<{ fileKey: string; processedFileKey: string; uploadUrl: string }>
  > {
    try {
      const results = files.map((file) => ({
        fileKey: file,
        processedFileKey: file,
        uploadUrl: file,
      }));

      const listing = await prisma.listing.findUnique({
        where: { id: propertyId },
        include: { user: true },
      });

      if (!listing?.user) {
        throw new Error("Listing or user not found");
      }

      await this.generatePropertyVideo(propertyId, files, listing.user.id);

      return results;
    } catch (error) {
      logger.error("Failed to process property images", {
        propertyId,
        error,
      });
      throw error;
    }
  }

  async generatePropertyVideo(
    propertyId: string,
    imageKeys: string[],
    userId: string,
    templateKey: TemplateKey = "crescendo"
  ): Promise<string> {
    try {
      const listing = await prisma.listing.findUnique({
        where: { id: propertyId },
        select: { coordinates: true },
      });

      const coordinates = listing?.coordinates
        ? typeof listing.coordinates === "string"
          ? JSON.parse(listing.coordinates)
          : listing.coordinates
        : undefined;

      const job = await prisma.videoJob.create({
        data: {
          userId,
          listingId: propertyId,
          status: VideoGenerationStatus.PENDING,
          inputFiles: imageKeys,
          template: templateKey,
        },
      });

      return this.productionPipeline.execute({
        jobId: job.id,
        inputFiles: imageKeys,
        template: templateKey,
        coordinates,
      });
    } catch (error) {
      logger.error("Failed to generate property video", {
        propertyId,
        userId,
        error,
      });
      throw error;
    }
  }

  async cleanupTemporaryFiles(fileKeys: string[]): Promise<void> {
    try {
      await Promise.all(
        fileKeys.map((key) => this.storageService.deleteFile(key))
      );
    } catch (error) {
      logger.error("Failed to cleanup temporary files", {
        fileKeys,
        error,
      });
      // Don't throw here as this is cleanup
    }
  }
}
