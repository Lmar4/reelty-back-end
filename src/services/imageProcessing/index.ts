import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { StorageService } from "../storage";
import { ProductionPipeline } from "../imageProcessing/productionPipeline";
import { TemplateKey } from "../imageProcessing/templates/types";
import { logger } from "../../utils/logger";

const prisma = new PrismaClient();

interface S3ValidationResult {
  isValid: boolean;
  error?: string;
}

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

  private validateS3Url(url: string): S3ValidationResult {
    // Validate HTTPS S3 URL format
    const s3UrlPattern =
      /^https:\/\/[\w-]+\.s3\.[\w-]+\.amazonaws\.com\/[\w\-/.]+$/;

    if (!url.startsWith("https://")) {
      return {
        isValid: false,
        error: `URL must start with https:// - Got: ${url}`,
      };
    }

    if (!s3UrlPattern.test(url)) {
      return {
        isValid: false,
        error: `Invalid S3 URL format - Got: ${url}`,
      };
    }

    return { isValid: true };
  }

  async processPropertyImages(
    propertyId: string,
    files: string[] // S3 URLs from frontend
  ): Promise<
    Array<{ fileKey: string; processedFileKey: string; uploadUrl: string }>
  > {
    let videoJob: { id: string } | null = null;

    try {
      // Validate all S3 URLs first
      const invalidFiles = files
        .map((file) => ({
          url: file,
          ...this.validateS3Url(file),
        }))
        .filter((result) => !result.isValid);

      if (invalidFiles.length > 0) {
        throw new Error(
          `Invalid S3 URLs found: ${invalidFiles
            .map((f) => f.error)
            .join(", ")}`
        );
      }

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

      // Create video job first
      videoJob = await prisma.videoJob.create({
        data: {
          userId: listing.user.id,
          listingId: propertyId,
          status: VideoGenerationStatus.PENDING,
          inputFiles: files,
          template: "crescendo",
        },
      });

      // Generate video with proper error handling
      try {
        await this.generatePropertyVideo(
          propertyId,
          files,
          listing.user.id,
          "crescendo",
          videoJob.id
        );
      } catch (error) {
        // Update job status on failure
        await prisma.videoJob.update({
          where: { id: videoJob.id },
          data: {
            status: VideoGenerationStatus.FAILED,
            error: error instanceof Error ? error.message : "Unknown error",
            completedAt: new Date(),
          },
        });
        throw error;
      }

      return results;
    } catch (error) {
      logger.error("Failed to process property images", {
        propertyId,
        error: error instanceof Error ? error.message : "Unknown error",
        jobId: videoJob?.id,
      });

      // Ensure job is marked as failed if it exists
      if (videoJob) {
        await prisma.videoJob
          .update({
            where: { id: videoJob.id },
            data: {
              status: VideoGenerationStatus.FAILED,
              error: error instanceof Error ? error.message : "Unknown error",
              completedAt: new Date(),
            },
          })
          .catch((updateError) => {
            logger.error("Failed to update video job status", {
              jobId: videoJob?.id,
              error:
                updateError instanceof Error
                  ? updateError.message
                  : "Unknown error",
            });
          });
      }

      throw error;
    }
  }

  async generatePropertyVideo(
    propertyId: string,
    imageKeys: string[],
    userId: string,
    templateKey: TemplateKey = "crescendo",
    existingJobId?: string
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

      // Only create a new job if one wasn't provided
      const jobId =
        existingJobId ||
        (
          await prisma.videoJob.create({
            data: {
              userId,
              listingId: propertyId,
              status: VideoGenerationStatus.PENDING,
              inputFiles: imageKeys,
              template: templateKey,
            },
          })
        ).id;

      return this.productionPipeline.execute({
        jobId,
        inputFiles: imageKeys,
        template: templateKey,
        coordinates,
      });
    } catch (error) {
      logger.error("Failed to generate property video", {
        propertyId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
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
        error: error instanceof Error ? error.message : "Unknown error",
      });
      // Don't throw here as this is cleanup
    }
  }
}
