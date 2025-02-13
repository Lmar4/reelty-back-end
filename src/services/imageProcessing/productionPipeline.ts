import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { prisma } from "../../lib/prisma";
import { ThumbnailService } from "../thumbnailService";
import { ImageToVideoConverter } from "./imageToVideoConverter";
import { MapCapture } from "./mapCapture";
import { TemplateKey } from "./templates/types";
import { VisionProcessor } from "./visionProcessor";

const prismaClient = new PrismaClient();

interface ProcessingStep {
  id: string;
  type: "webp" | "crop" | "runway" | "ffmpeg";
  input: string[];
  output: string[];
  settings: any;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  metadata?: {
    cacheKey?: string;
    processingTime?: number;
  };
}

interface ProcessingJob {
  id: string;
  steps: ProcessingStep[];
  templates: string[];
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
}

interface ProductionPipelineInput {
  jobId: string;
  inputFiles: string[];
  template: string;
  coordinates?: { lat: number; lng: number };
  isRegeneration?: boolean;
}

export class ProductionPipeline {
  private s3Client: S3Client;
  private imageToVideoConverter: ImageToVideoConverter;
  private visionProcessor: VisionProcessor;
  private mapCapture: MapCapture;
  private thumbnailService: ThumbnailService;
  private processingSteps: Map<string, ProcessingStep>;

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
    });
    this.imageToVideoConverter = new ImageToVideoConverter(
      process.env.RUNWAYML_API_KEY || "",
      process.env.TEMP_OUTPUT_DIR || "./temp"
    );
    this.visionProcessor = new VisionProcessor();
    this.mapCapture = new MapCapture(process.env.TEMP_OUTPUT_DIR || "./temp");
    this.thumbnailService = new ThumbnailService();
    this.processingSteps = new Map();
  }

  private async updateJobStatus(
    jobId: string,
    status: VideoGenerationStatus,
    error?: string
  ): Promise<void> {
    console.log("Updating job status:", { jobId, status, error });
    await prismaClient.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        error,
      },
    });
  }

  private parseS3Path(s3Path: string): { bucket: string; key: string } {
    return this.imageToVideoConverter.parseS3Path(s3Path);
  }

  private async downloadFromS3(
    s3Path: string,
    outputPath?: string
  ): Promise<string> {
    try {
      // Use ImageToVideoConverter's comprehensive processing
      const { localWebpPath, uploadPromise } =
        await this.imageToVideoConverter.processImage(s3Path);

      // Wait for the upload to complete to ensure consistency
      await uploadPromise;

      return localWebpPath;
    } catch (error) {
      console.error("S3 download and processing failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Path,
        outputPath,
      });
      throw error;
    }
  }

  private async uploadToS3(
    localPath: string,
    destinationPath: string
  ): Promise<string> {
    try {
      await this.imageToVideoConverter.uploadToS3(localPath, destinationPath);
      return `s3://${this.parseS3Path(destinationPath).bucket}/${
        this.parseS3Path(destinationPath).key
      }`;
    } catch (error) {
      console.error("S3 upload failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        localPath,
        destinationPath,
      });
      throw error;
    }
  }

  private async cleanupFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to cleanup file ${filePath}:`, error);
    }
  }

  private async checkWebPExists(s3Path: string): Promise<boolean> {
    try {
      const webpS3Path = s3Path.replace(/\.[^.]+$/, ".webp");
      const { bucket, key } = this.parseS3Path(webpS3Path);

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      return false;
    }
  }

  private async getExistingWebP(s3Path: string): Promise<{
    localWebpPath: string;
    s3WebpPath: string;
    uploadPromise: Promise<void>;
  }> {
    const webpS3Path = s3Path.replace(/\.[^.]+$/, ".webp");
    const localWebpPath = await this.downloadFromS3(webpS3Path);

    // Since the WebP already exists in S3, we create a resolved promise
    const uploadPromise = Promise.resolve();

    return {
      localWebpPath,
      s3WebpPath: webpS3Path,
      uploadPromise,
    };
  }

  private async processImage(s3Path: string): Promise<{
    localWebpPath: string;
    s3WebpPath: string;
    uploadPromise: Promise<any>;
  }> {
    // Create a unique process directory
    const processDir = path.join(
      os.tmpdir(),
      `process-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );
    await fs.promises.mkdir(processDir, { recursive: true });

    // Check if WebP version already exists
    const originalKey = this.parseS3Path(s3Path).key;
    const existingPhoto = await prismaClient.photo.findFirst({
      where: { filePath: originalKey, processedFilePath: { not: null } },
    });

    if (existingPhoto?.processedFilePath) {
      const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${existingPhoto.processedFilePath}`;
      const localWebpPath = path.join(
        processDir,
        path.basename(existingPhoto.processedFilePath)
      );
      await this.downloadFromS3(s3WebpPath, localWebpPath);

      return {
        localWebpPath,
        s3WebpPath,
        uploadPromise: Promise.resolve(),
      };
    }

    // If no WebP exists, proceed with the original conversion process
    let originalPath: string | null = null;
    let webpPath: string | null = null;
    let uploadPromise: Promise<any> = Promise.resolve();

    try {
      // Download original to the process directory
      originalPath = path.join(processDir, path.basename(s3Path));
      await this.downloadFromS3(s3Path, originalPath);

      // Validate the downloaded image
      const validation = await this.imageToVideoConverter.validateImage(
        originalPath
      );
      if (!validation.isValid) {
        throw new Error(`Invalid image: ${validation.error}`);
      }

      // Convert to WebP in the same process directory
      webpPath = path.join(
        processDir,
        `${path.basename(s3Path, path.extname(s3Path))}.webp`
      );

      await this.imageToVideoConverter.convertToWebP(originalPath, webpPath, {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
      });

      // Create upload promise that includes S3 upload and database update
      const webpS3Path = s3Path.replace(/\.[^.]+$/, ".webp");
      uploadPromise = this.uploadToS3(webpPath, webpS3Path)
        .then(async () => {
          // Update the photo record in the database with the WebP path
          const webpKey = this.parseS3Path(webpS3Path).key;
          await prismaClient.photo.updateMany({
            where: { filePath: originalKey },
            data: { processedFilePath: webpKey },
          });

          console.log("Updated photo record with WebP path:", {
            original: originalKey,
            webp: webpKey,
          });
        })
        .catch((error) => {
          console.error("WebP upload failed:", {
            error: error instanceof Error ? error.message : "Unknown error",
            s3Path: webpS3Path,
          });
          throw error;
        })
        .finally(async () => {
          try {
            // Clean up the process directory after upload is complete
            await fs.promises.rm(processDir, { recursive: true, force: true });
          } catch (error) {
            console.error("Failed to cleanup process directory:", {
              dir: processDir,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        });

      return {
        localWebpPath: webpPath,
        s3WebpPath: webpS3Path,
        uploadPromise,
      };
    } catch (error) {
      // Clean up on error
      try {
        await fs.promises.rm(processDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Failed to cleanup on error:", {
          dir: processDir,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : "Unknown error",
        });
      }

      console.error("Error processing image:", {
        s3Path,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    initialDelay: number = 2000,
    operationName: string = "operation"
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        console.log(
          `Attempting ${operationName} (attempt ${
            attempt + 1
          }/${maxRetries})...`
        );
        const result = await operation();
        if (attempt > 0) {
          console.log(
            `${operationName} succeeded after ${attempt + 1} attempts`
          );
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        console.error(`${operationName} failed:`, {
          attempt: attempt + 1,
          maxRetries,
          error: lastError.message,
        });

        if (attempt < maxRetries - 1) {
          const delay = initialDelay * Math.pow(2, attempt); // Exponential backoff
          console.log(`Retrying ${operationName} in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.error(`All retry attempts for ${operationName} failed`);
        }
      }
    }
    throw lastError;
  }

  private async processWebP(
    input: string[],
    isRegeneration: boolean = false
  ): Promise<ProcessingStep> {
    const step: ProcessingStep = {
      id: `webp-${Date.now()}`,
      type: "webp",
      input,
      output: [],
      settings: {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
      },
      status: "processing",
    };

    try {
      const results = await Promise.all(
        input.map(async (file) => {
          const result = await this.processImage(file);
          return result.localWebpPath;
        })
      );

      step.output = results;
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
    }

    this.processingSteps.set(step.id, step);
    return step;
  }

  private async processRunway(input: string[]): Promise<ProcessingStep> {
    const step: ProcessingStep = {
      id: `runway-${Date.now()}`,
      type: "runway",
      input,
      output: [],
      settings: {
        duration: 5,
        ratio: "768:1280",
        watermark: false,
      },
      status: "processing",
    };

    try {
      const results = await Promise.all(
        input.map(async (file) => {
          const result = await this.retryOperation(
            async () => {
              return await this.imageToVideoConverter.convertImagesToVideo(
                [file],
                {
                  duration: 5,
                  ratio: "768:1280",
                  watermark: false,
                }
              );
            },
            3,
            2000,
            "Runway API call"
          );
          return result;
        })
      );

      step.output = results;
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      if (error instanceof Error) {
        step.error = error.message;
        // Check for specific error types
        if (error.message.includes("Rate limit exceeded")) {
          step.error = "Rate limit exceeded. Please try again later.";
        } else if (error.message.includes("Invalid input parameters")) {
          step.error = "Invalid input parameters for video generation.";
        } else if (error.message.includes("service temporarily unavailable")) {
          step.error =
            "Runway service is temporarily unavailable. Please try again later.";
        }
      } else {
        step.error = "Unknown error occurred during video generation";
      }

      console.error("Runway processing failed:", {
        error: step.error,
        input,
      });
    }

    this.processingSteps.set(step.id, step);
    return step;
  }

  private async processTemplates(
    input: string[],
    templates: string[],
    mapVideoPath?: string
  ): Promise<ProcessingStep> {
    const step: ProcessingStep = {
      id: `templates-${Date.now()}`,
      type: "ffmpeg",
      input,
      output: [],
      settings: { templates },
      status: "processing",
    };

    try {
      const results = await Promise.all(
        templates.map(async (template) => {
          const result = await this.imageToVideoConverter.createTemplate(
            template.toLowerCase().replace(/\s+/g, "_") as TemplateKey,
            input,
            mapVideoPath
          );
          return result;
        })
      );

      step.output = results;
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
    }

    this.processingSteps.set(step.id, step);
    return step;
  }

  async execute({
    jobId,
    inputFiles,
    template,
    coordinates,
    isRegeneration = false,
  }: ProductionPipelineInput): Promise<string> {
    try {
      // Get job details
      const job = await prisma.videoJob.findUnique({
        where: { id: jobId },
        include: {
          listing: {
            include: {
              user: true,
            },
          },
        },
      });

      if (!job || !job.listing || !job.listing.user || !job.listing.address) {
        throw new Error(`Invalid job data for ${jobId}`);
      }

      // Get all templates
      const allTemplates = await prisma.template.findMany({
        orderBy: { order: "asc" },
      });

      // Process WebP conversion or download existing WebPs if regenerating
      const webpStep = await this.processWebP(inputFiles, isRegeneration);
      if (webpStep.status === "failed") {
        throw new Error(`WebP processing failed: ${webpStep.error}`);
      }

      // Process map video if needed
      let mapVideoPath: string | undefined;
      if (template === "googlezoomintro") {
        if (!coordinates) {
          throw new Error(
            "Coordinates are required for Google Maps zoom template"
          );
        }

        if (!process.env.GOOGLE_MAPS_API_KEY) {
          throw new Error("Google Maps API key is not configured");
        }

        try {
          const mapFrames = await this.mapCapture.captureMapAnimation(
            job.listing.address,
            coordinates
          );

          if (!mapFrames || mapFrames.length === 0) {
            throw new Error("Failed to generate map frames");
          }

          mapVideoPath = mapFrames[0];
          console.log("Successfully generated map video:", mapVideoPath);
        } catch (error) {
          throw new Error(
            `Failed to generate map video: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      // Process Runway videos
      const runwayStep = await this.processRunway(webpStep.output);
      if (runwayStep.status === "failed") {
        throw new Error(`Runway processing failed: ${runwayStep.error}`);
      }

      // Process all templates
      const templateStep = await this.processTemplates(
        runwayStep.output,
        allTemplates.map((t) => t.name),
        mapVideoPath
      );

      if (templateStep.status === "failed") {
        throw new Error(`Template processing failed: ${templateStep.error}`);
      }

      // Upload final video to S3
      const outputFile = templateStep.output[0]; // Use the first template output as main output
      const s3Key = `videos/${path.basename(outputFile)}`;
      const s3Url = await this.uploadToS3(
        outputFile,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      // Generate and upload thumbnail
      const dbTemplate = await prisma.template.findFirst({
        where: { name: template },
      });

      if (dbTemplate && !dbTemplate.thumbnailUrl) {
        try {
          await this.thumbnailService.generateAndUploadThumbnail(
            outputFile,
            dbTemplate.id
          );
        } catch (error) {
          console.error("[THUMBNAIL_ERROR]", error);
          // Don't fail the whole process if thumbnail generation fails
        }
      }

      // Update job with S3 URL
      await prisma.videoJob.update({
        where: { id: jobId },
        data: { outputFile: s3Url, status: "COMPLETED" },
      });

      return s3Url;
    } catch (error) {
      console.error("[CREATE_JOB] Production pipeline error:", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  async regeneratePhotos(jobId: string, photoIds: string[]): Promise<void> {
    const job = await prisma.videoJob.findUnique({
      where: { id: jobId },
      include: {
        listing: {
          include: {
            photos: true,
          },
        },
      },
    });

    if (!job || !job.listing) {
      throw new Error("Invalid job or listing not found");
    }

    try {
      // Update job status
      await this.updateJobStatus(jobId, VideoGenerationStatus.PROCESSING);

      // Regenerate videos for selected photos
      const regeneratedVideos =
        await this.imageToVideoConverter.regenerateVideos(photoIds);

      // Get all video segments (both regenerated and existing)
      const allPhotos = job.listing.photos;
      const videoSegments = allPhotos
        .map((photo) => {
          const regeneratedIndex = photoIds.indexOf(photo.id);
          if (regeneratedIndex !== -1) {
            return regeneratedVideos[regeneratedIndex];
          }
          return photo.runwayVideoPath || null;
        })
        .filter(Boolean) as string[];

      if (!job.template) {
        throw new Error("Job template is required");
      }

      // Create a new final video with the updated segments
      const outputPath = await this.imageToVideoConverter.createTemplate(
        job.template as TemplateKey,
        videoSegments
      );

      // Upload the new video to S3
      const s3Key = `videos/${path.basename(outputPath)}`;
      const s3Url = await this.uploadToS3(
        outputPath,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      // Update job with new video URL
      await prisma.videoJob.update({
        where: { id: jobId },
        data: {
          outputFile: s3Url,
          status: VideoGenerationStatus.COMPLETED,
          error: null,
        },
      });
    } catch (error) {
      console.error("Error during photo regeneration:", error);
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        error instanceof Error
          ? error.message
          : "Unknown error during regeneration"
      );
      throw error;
    }
  }
}
