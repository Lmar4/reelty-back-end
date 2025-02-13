import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import path from "path";
import { AllowedMimeTypes } from "../../config/storage";
import { StorageService } from "../storage";
import { MapCapture } from "./mapCapture";
import { ProductionPipeline } from "./productionPipeline";
import { TemplateKey } from "./templates/types";
import { VisionProcessor } from "./visionProcessor";
import { logger } from "../../utils/logger";

const prisma = new PrismaClient();

export class ImageProcessingService {
  private static instance: ImageProcessingService;
  private storageService: StorageService;
  private productionPipeline: ProductionPipeline;
  private visionProcessor: VisionProcessor;

  private constructor() {
    this.storageService = StorageService.getInstance();
    this.productionPipeline = new ProductionPipeline();
    this.visionProcessor = new VisionProcessor();
  }

  public static getInstance(): ImageProcessingService {
    if (!ImageProcessingService.instance) {
      ImageProcessingService.instance = new ImageProcessingService();
    }
    return ImageProcessingService.instance;
  }

  private async processAndUploadImage(
    propertyId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
      buffer: Buffer;
    }
  ) {
    // Upload original file first
    const originalResult = await this.storageService.uploadPropertyMedia(
      propertyId,
      {
        name: file.name,
        type: "image",
        contentType: file.contentType,
        buffer: file.buffer,
      }
    );

    // Convert to WebP
    const webpBuffer = await this.visionProcessor.convertBufferToWebP(
      file.buffer,
      {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
      }
    );

    // Generate WebP filename
    const parsedName = path.parse(file.name);
    const webpName = `${parsedName.name}.webp`;

    // Upload WebP version
    const webpResult = await this.storageService.uploadPropertyMedia(
      propertyId,
      {
        name: webpName,
        type: "image",
        contentType: "image/webp",
        buffer: webpBuffer,
      }
    );

    return {
      originalKey: originalResult.fileKey,
      webpKey: webpResult.fileKey,
    };
  }

  async processPropertyImages(
    propertyId: string,
    files: Array<{
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
      buffer: Buffer;
    }>
  ): Promise<
    Array<{ fileKey: string; processedFileKey: string; uploadUrl: string }>
  > {
    const results = await Promise.all(
      files.map(async (file) => {
        const { originalKey, webpKey } = await this.processAndUploadImage(
          propertyId,
          file
        );

        // Find the photo record by propertyId and original file path
        const photo = await prisma.photo.findFirst({
          where: {
            listingId: propertyId,
            filePath: originalKey,
          },
        });

        if (photo) {
          // Update the photo record with the processed file path
          await prisma.photo.update({
            where: { id: photo.id },
            data: {
              processedFilePath: webpKey,
              status: "completed",
            },
          });
        }

        return {
          fileKey: originalKey,
          processedFileKey: webpKey,
          uploadUrl: await this.storageService.getSignedUrl(webpKey),
        };
      })
    );

    // After all photos are processed, get the listing to check if we should generate video
    const listing = await prisma.listing.findUnique({
      where: { id: propertyId },
      include: {
        photos: true,
        user: true,
      },
    });

    if (listing && listing.photos.length > 0 && listing.user) {
      // Get all processed photo keys
      const processedPhotoKeys = listing.photos
        .filter(
          (photo) => photo.processedFilePath && photo.status === "completed"
        )
        .map((photo) => photo.processedFilePath as string);

      if (processedPhotoKeys.length > 0) {
        try {
          // Generate video with default template
          await this.generatePropertyVideo(
            propertyId,
            processedPhotoKeys,
            listing.user.id
          );
        } catch (error) {
          logger.error("Failed to generate video after photo upload", {
            propertyId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    }

    return results;
  }

  async generatePropertyVideo(
    propertyId: string,
    imageKeys: string[],
    userId: string,
    templateKey: TemplateKey = "crescendo"
  ): Promise<string> {
    // Create a video job
    const job = await prisma.videoJob.create({
      data: {
        userId,
        listingId: propertyId,
        status: "PENDING" as VideoGenerationStatus,
        inputFiles: imageKeys,
        template: templateKey,
      },
    });

    // Start the production pipeline
    const outputFile = await this.productionPipeline.execute({
      jobId: job.id,
      inputFiles: imageKeys,
      template: templateKey,
    });

    if (!outputFile) {
      throw new Error("Failed to generate video");
    }

    return outputFile;
  }

  async processMapCapture(
    propertyId: string,
    address: string
  ): Promise<string> {
    const mapCapture = new MapCapture(
      process.env.TEMP_OUTPUT_DIR || "./temp/maps"
    );
    const mapFrames = await mapCapture.captureMapAnimation(address);

    // Upload map frames
    const uploadedFrames = await Promise.all(
      mapFrames.map(async (framePath) => {
        const result = await this.storageService.uploadPropertyMedia(
          propertyId,
          {
            name: `map-frame-${Date.now()}.webp`,
            type: "image",
            contentType: "image/webp",
          }
        );
        return result.fileKey;
      })
    );

    return uploadedFrames[0]; // Return the first frame as preview
  }

  async cleanupTemporaryFiles(fileKeys: string[]): Promise<void> {
    await Promise.all(
      fileKeys.map((key) => this.storageService.deleteFile(key))
    );
  }
}
