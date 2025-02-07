import { PrismaClient } from "@prisma/client";
import { AllowedMimeTypes } from "../../config/storage";
import { StorageService } from "../storage";
import { ProductionPipeline } from "./productionPipeline";
import { MapCapture } from "./mapCapture";
import { TemplateKey } from "./templates/types";

const prisma = new PrismaClient();

export class ImageProcessingService {
  private static instance: ImageProcessingService;
  private storageService: StorageService;
  private productionPipeline: ProductionPipeline;

  private constructor() {
    this.storageService = StorageService.getInstance();
    this.productionPipeline = new ProductionPipeline(
      process.env.RUNWAY_API_KEY || "",
      process.env.TEMP_OUTPUT_DIR || "./temp"
    );
  }

  public static getInstance(): ImageProcessingService {
    if (!ImageProcessingService.instance) {
      ImageProcessingService.instance = new ImageProcessingService();
    }
    return ImageProcessingService.instance;
  }

  async processPropertyImages(
    propertyId: string,
    files: Array<{
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
      buffer: Buffer;
    }>
  ): Promise<Array<{ fileKey: string; uploadUrl: string }>> {
    const results = await Promise.all(
      files.map(async (file) => {
        return this.storageService.uploadPropertyMedia(propertyId, {
          name: file.name,
          type: "image",
          contentType: file.contentType,
        });
      })
    );

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
        status: "pending",
        inputFiles: imageKeys,
        template: templateKey,
      },
    });

    // Start the production pipeline
    const success = await this.productionPipeline.runProductionPipeline(job.id);
    if (!success) {
      throw new Error("Failed to generate video");
    }

    // Get the updated job to return the output file
    const updatedJob = await prisma.videoJob.findUnique({
      where: { id: job.id },
    });

    if (!updatedJob?.outputFile) {
      throw new Error("Video generation completed but output file is missing");
    }

    return updatedJob.outputFile;
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
