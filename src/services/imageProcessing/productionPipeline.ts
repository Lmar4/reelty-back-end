import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { ImageToVideoConverter } from "./imageToVideoConverter";
import { MapCapture } from "./mapCapture";
import { TemplateKey } from "./templates/types";
import { VisionProcessor } from "./visionProcessor";
import { prisma } from "../../lib/prisma";
import { logger } from "../../utils/logger";

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
}

export class ProductionPipeline {
  private imageToVideoConverter: ImageToVideoConverter;
  private mapCapture: MapCapture;
  private visionProcessor: VisionProcessor;
  private processingSteps: Map<string, ProcessingStep>;

  constructor() {
    this.imageToVideoConverter = new ImageToVideoConverter(
      process.env.RUNWAYML_API_KEY || "",
      process.env.TEMP_OUTPUT_DIR || "./temp"
    );
    this.mapCapture = new MapCapture(process.env.TEMP_OUTPUT_DIR || "./temp");
    this.visionProcessor = new VisionProcessor();
    this.processingSteps = new Map();
  }

  private async updateJobStatus(
    jobId: string,
    status: "processing" | "completed" | "error",
    error?: string
  ): Promise<void> {
    console.log("Updating job status:", { jobId, status, error });
    await prismaClient.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        ...(error && { error }),
      },
    });
  }

  private parseS3Path(s3Path: string): { bucket: string; key: string } {
    try {
      const url = new URL(s3Path);
      const bucket = url.hostname.split(".")[0];
      const key = url.pathname.substring(1); // Remove leading slash
      return { bucket, key };
    } catch (error) {
      // If not a URL, try the old s3:// format
      const [, bucket, ...keyParts] = s3Path.replace("s3://", "").split("/");
      return { bucket, key: keyParts.join("/") };
    }
  }

  private async downloadFromS3(s3Path: string): Promise<string> {
    console.log("Downloading from S3:", { s3Path });
    try {
      const s3Client = new S3Client({ region: process.env.AWS_REGION });
      const { bucket, key } = this.parseS3Path(s3Path);
      const localPath = path.join(os.tmpdir(), path.basename(key));

      console.log("Parsed S3 path:", { bucket, key, localPath });

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: decodeURIComponent(key), // Decode the URL-encoded key
      });

      const response = await s3Client.send(command);

      if (response.Body) {
        const writeStream = fs.createWriteStream(localPath);
        await new Promise((resolve, reject) => {
          if (response.Body instanceof Readable) {
            response.Body.pipe(writeStream)
              .on("finish", () => {
                console.log("S3 download complete:", { localPath });
                resolve(localPath);
              })
              .on("error", reject);
          } else {
            reject(new Error("Invalid response body type"));
          }
        });
      }

      return localPath;
    } catch (error) {
      console.error("Error downloading from S3:", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Path,
      });
      throw error;
    }
  }

  private async uploadToS3(
    localPath: string,
    destinationPath: string
  ): Promise<string> {
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const { bucket, key } = this.parseS3Path(destinationPath);

    const fileStream = fs.createReadStream(localPath);
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: "image/webp",
      },
    });

    await upload.done();
    return `s3://${bucket}/${key}`;
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
      const s3Client = new S3Client({ region: process.env.AWS_REGION });
      const webpS3Path = s3Path.replace(/\.[^.]+$/, ".webp");
      const { bucket, key } = this.parseS3Path(webpS3Path);

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await s3Client.send(command);
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
    uploadPromise: Promise<void>;
  }> {
    // First check if WebP version exists in the database
    const originalKey = this.parseS3Path(s3Path).key;
    const existingPhoto = await prismaClient.photo.findFirst({
      where: {
        filePath: originalKey,
        processedFilePath: { not: null },
      },
    });

    if (existingPhoto?.processedFilePath) {
      console.log("Found existing WebP in database:", {
        originalPath: originalKey,
        webpPath: existingPhoto.processedFilePath,
      });

      const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${existingPhoto.processedFilePath}`;
      const localWebpPath = await this.downloadFromS3(s3WebpPath);

      return {
        localWebpPath,
        s3WebpPath,
        uploadPromise: Promise.resolve(), // No need to upload since it already exists
      };
    }

    // If no WebP exists, proceed with the original conversion process
    let originalPath: string | null = null;
    let webpPath: string | null = null;

    try {
      // Download original
      originalPath = await this.downloadFromS3(s3Path);

      // Convert to WebP
      webpPath = await this.imageToVideoConverter.convertToWebP(
        originalPath,
        path.join(
          os.tmpdir(),
          `${Date.now()}-${path.basename(s3Path, path.extname(s3Path))}.webp`
        ),
        {
          quality: 80,
          width: 1080,
          height: 1920,
          fit: "cover",
        }
      );

      // Create upload promise that includes S3 upload and database update
      const webpS3Path = s3Path.replace(/\.[^.]+$/, ".webp");
      const uploadPromise = this.uploadToS3(webpPath, webpS3Path)
        .then(() => {
          // Update the photo record in the database with the WebP path
          const originalKey = this.parseS3Path(s3Path).key;
          const webpKey = this.parseS3Path(webpS3Path).key;
          return prismaClient.photo.updateMany({
            where: { filePath: originalKey },
            data: { processedFilePath: webpKey },
          });
        })
        .then(() => {
          console.log("Updated photo record with WebP path:", {
            original: this.parseS3Path(s3Path).key,
            webp: this.parseS3Path(webpS3Path).key,
          });
        })
        .catch((error) => {
          console.error("WebP upload failed:", {
            error: error instanceof Error ? error.message : "Unknown error",
            s3Path: webpS3Path,
          });
          throw error; // Re-throw to handle in the main pipeline
        });

      return {
        localWebpPath: webpPath,
        s3WebpPath: webpS3Path,
        uploadPromise,
      };
    } catch (error) {
      console.error("Error processing image:", {
        s3Path,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      // Only cleanup the original file, keep WebP for processing
      if (originalPath) await this.cleanupFile(originalPath);
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

  private async processWebP(input: string[]): Promise<ProcessingStep> {
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
      settings: { duration: 3 },
      status: "processing",
    };

    try {
      const results = await Promise.all(
        input.map(async (file) => {
          const result = await this.imageToVideoConverter.convertImagesToVideo(
            [file],
            { duration: 3 }
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
  }: ProductionPipelineInput): Promise<string> {
    try {
      // Get job details with user tier
      const job = await prisma.videoJob.findUnique({
        where: { id: jobId },
        include: {
          listing: {
            include: {
              user: {
                include: {
                  currentTier: true,
                },
              },
            },
          },
        },
      });

      if (!job || !job.listing || !job.listing.user || !job.listing.address) {
        throw new Error(`Invalid job data for ${jobId}`);
      }

      // Get all available templates for the user's tier
      const availableTemplates = await prisma.template.findMany({
        where: {
          subscriptionTiers: {
            some: {
              id: job.listing.user.currentTier?.id,
            },
          },
        },
      });

      if (availableTemplates.length === 0) {
        throw new Error("No templates available for user tier");
      }

      // Process WebP conversion
      const webpStep = await this.processWebP(inputFiles);
      if (webpStep.status === "failed") {
        throw new Error(`WebP processing failed: ${webpStep.error}`);
      }

      // Process map video if needed
      let mapVideoPath: string | undefined;
      if (coordinates && template.toLowerCase().includes("google_zoom")) {
        const mapFrames = await this.mapCapture.captureMapAnimation(
          job.listing.address
        );
        if (mapFrames.length > 0) {
          mapVideoPath = mapFrames[0];
        }
      }

      // Process Runway videos
      const runwayStep = await this.processRunway(webpStep.output);
      if (runwayStep.status === "failed") {
        throw new Error(`Runway processing failed: ${runwayStep.error}`);
      }

      // Process all available templates in parallel
      const templateStep = await this.processTemplates(
        runwayStep.output,
        availableTemplates.map((t) => t.name),
        mapVideoPath
      );
      if (templateStep.status === "failed") {
        throw new Error(`Template processing failed: ${templateStep.error}`);
      }

      // Return the video for the requested template
      const templateIndex = availableTemplates.findIndex(
        (t) => t.name.toLowerCase() === template.toLowerCase()
      );

      return templateStep.output[templateIndex] || templateStep.output[0];
    } catch (error) {
      logger.error("Production pipeline failed:", { jobId, error });
      throw error;
    }
  }
}
