import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  AssetType,
  Photo,
  Prisma,
  PrismaClient,
  VideoGenerationStatus,
} from "@prisma/client";
import crypto from "crypto";
import { createReadStream } from "fs";
import fs from "fs/promises";
import ffmpeg, { FfprobeData, FfprobeStream } from "fluent-ffmpeg"; // Include the types
import pLimit from "p-limit";
import path from "path";
import sharp from "sharp";
import { Readable } from "stream";
import { logger } from "../../utils/logger.js";
import { streamToBuffer } from "../../utils/streamToBuffer.js";
import { AssetManager } from "../assets/asset-manager.js";
import { AssetCacheService } from "../cache/assetCache.js";
import { mapCaptureService } from "../map-capture/map-capture.service.js";
import { resourceManager, ResourceState } from "../storage/resource-manager.js";
import { S3Service } from "../storage/s3.service.js";
import { runwayService } from "../video/runway.service.js";
import { S3VideoService } from "../video/s3-video.service.js";
import {
  videoProcessingService,
  VideoClip,
} from "../video/video-processing.service.js";
import { reelTemplates, TemplateKey } from "./templates/types.js";
import {
  ImageOptimizationOptions,
  VisionProcessor,
} from "./visionProcessor.js";
import {
  VideoTemplate,
  WatermarkConfig,
} from "../video/video-template.service.js";
import { existsSync } from "fs";
import { VideoTemplateService } from "../video/video-template.service.js";
import { ReelTemplate } from "./templates/types.js";
import { ffmpegQueueManager } from "../ffmpegQueueManager.js";

const ALL_TEMPLATES: TemplateKey[] = [
  "crescendo",
  "wave",
  "storyteller",
  "googlezoomintro",
  "wesanderson",
  "hyperpop",
] as const;

interface ProductionPipelineInput {
  jobId: string;
  listingId?: string;
  inputFiles: string[];
  template: TemplateKey;
  coordinates?: { lat: number; lng: number };
  isRegeneration?: boolean;
  regenerationContext?: RegenerationContext;
  skipRunway?: boolean;
  skipRunwayIfCached?: boolean;
  allTemplates?: boolean;
  skipLock?: boolean;
  forceRegeneration?: boolean;
  metadata?: {
    processedTemplates?: {
      key: string;
      path: string;
      usedFallback?: boolean;
    }[];
    [key: string]: any;
  };
}

interface RegenerationContext {
  photosToRegenerate: Array<{
    id: string;
    processedFilePath: string;
    order: number;
    filePath: string;
  }>;
  existingPhotos: Array<{
    id: string;
    processedFilePath: string;
    order: number;
    runwayVideoPath?: string;
  }>;
  regeneratedPhotoIds: string[];
  totalPhotos: number;
}

interface JobProgress {
  stage: "runway" | "template" | "upload" | "vision";
  subStage?: string;
  progress: number;
  message?: string;
  error?: string;
}

interface TemplateProcessingResult {
  template: TemplateKey;
  status: "SUCCESS" | "FAILED";
  outputPath: string | null;
  error?: string;
  processingTime?: number;
  usedFallback?: boolean;
}

interface ProcessingVideo {
  order: number;
  path: string;
  id?: string;
}

interface ProcessingImage {
  order: number;
  path: string;
  id?: string;
}

// Nuevas interfaces para el manejo de validación y resultados
interface ValidationResult {
  success: boolean;
  duration?: number;
  error?: string;
}

interface RunwayGenerationResult {
  s3Url: string;
  duration: number;
  validated: boolean;
  metadata?: Record<string, unknown>;
}

interface ValidationCache {
  s3Url: string;
  duration: number;
  validatedAt: Date;
  metadata?: Record<string, unknown>;
}

// Primero, agregar una interfaz para el manejo de recursos
interface ResourceTracker {
  path: string;
  type: "temp" | "video" | "music" | "watermark";
  metadata?: Record<string, unknown>;
}

interface ValidatedVideo {
  path: string;
  duration: number;
}

// Add this interface near the top of the file with other interfaces
interface FFprobeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface FFprobeMetadata {
  streams: FFprobeStream[];
  format: {
    duration?: string;
  };
}

class ResourceManager {
  public tempFiles: Set<string> = new Set();

  async trackResource(path: string) {
    this.tempFiles.add(path);
  }

  async cleanup() {
    const filesToDelete = Array.from(this.tempFiles);
    logger.info(`Cleaning up ${filesToDelete.length} temporary files`);

    await Promise.all(
      filesToDelete.map(async (file) => {
        try {
          // Check if file exists before attempting to delete
          try {
            await fs.access(file);
          } catch (accessError) {
            // File doesn't exist, just remove from tracking
            this.tempFiles.delete(file);
            return;
          }

          // File exists, delete it
          await fs.unlink(file);
          this.tempFiles.delete(file);
          logger.debug(`Deleted temporary file: ${file}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(`Failed to cleanup ${file}:`, error);
          } else {
            // If file not found, still remove from tracking
            this.tempFiles.delete(file);
          }
        }
      })
    );
  }
}

export class ProductionPipeline {
  private async getFileDescriptorCount(jobId: string): Promise<number> {
    try {
      const files = await fs.readdir("/proc/self/fd");
      return files.length;
    } catch (error) {
      logger.warn(`[${jobId}] Failed to get file descriptor count`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return 0;
    }
  }

  private readonly MEMORY_WARNING_THRESHOLD = 0.7; // 70% memory usage triggers warning
  private readonly MEMORY_CRITICAL_THRESHOLD = 0.8; // 80% memory usage triggers reduction
  private readonly MEMORY_STABLE_THRESHOLD = 0.4; // 40% memory usage considered stable
  private readonly MEMORY_RESET_THRESHOLD = 0.3; // 30% memory usage triggers reset
  private readonly BATCH_SIZE_ADJUSTMENT_INTERVAL = 5000; // 5 seconds between adjustments
  private lastBatchSizeAdjustment: number = 0;
  private readonly MAX_RETRIES = 3;
  private getDefaultBatchSize(isRegeneration?: boolean): number {
    return isRegeneration ? 2 : 5;
  }
  private readonly DEFAULT_BATCH_SIZE = this.getDefaultBatchSize(); // Default for non-regeneration
  private readonly MIN_BATCH_SIZE = 1;
  private readonly TEMP_DIRS = { OUTPUT: "temp/output" };
  private readonly bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
  private readonly region = process.env.AWS_REGION || "us-east-2";

  private readonly MAX_RUNWAY_RETRIES = 3;
  private readonly INITIAL_RETRY_DELAY = 1000;
  private readonly LOCK_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  private s3Client: S3Client;
  private resourceManager: ResourceManager;
  private currentBatchSize: number;
  private limit: ReturnType<typeof pLimit>;
  private assetCacheService: AssetCacheService;
  private s3Service: S3Service;
  private s3VideoService: S3VideoService;
  private readonly assetManager: AssetManager;
  private readonly visionProcessor: VisionProcessor;
  private readonly IMAGE_OPTIMIZATION_OPTIONS: ImageOptimizationOptions = {
    width: 768,
    height: 1280,
    quality: 80,
    fit: "cover",
  };

  private validationCache = new Map<string, ValidationCache>();
  private readonly VALIDATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly prisma: PrismaClient = new PrismaClient()) {
    this.resourceManager = new ResourceManager();
    this.currentBatchSize = this.getDefaultBatchSize();
    this.limit = pLimit(this.currentBatchSize);
    this.assetCacheService = AssetCacheService.getInstance();
    this.initializeTempDirectories();

    const region = process.env.AWS_REGION || "us-east-2";
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error("Missing required AWS environment variables.");
    }

    this.s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });

    this.s3Service = new S3Service();
    this.s3VideoService = S3VideoService.getInstance();
    this.assetManager = AssetManager.getInstance();
    this.visionProcessor = new VisionProcessor();
  }

  private async initializeTempDirectories() {
    await Promise.all(
      Object.values(this.TEMP_DIRS).map(async (dir) => {
        const fullPath = path.join(process.cwd(), dir);
        await fs.mkdir(fullPath, { recursive: true });
        logger.info(`Initialized temp directory: ${fullPath}`);
      })
    );
  }

  private getTempPath(
    type: keyof typeof this.TEMP_DIRS,
    filename: string
  ): string {
    return path.join(process.cwd(), this.TEMP_DIRS[type], filename);
  }

  private async updateJobProgress(
    jobId: string,
    progress: JobProgress
  ): Promise<void> {
    const { stage, subStage, progress: value, message, error } = progress;
    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status: error
          ? VideoGenerationStatus.FAILED
          : VideoGenerationStatus.PROCESSING,
        progress: value,
        error,
        metadata: {
          currentStage: stage,
          currentSubStage: subStage,
          message,
          lastUpdated: new Date().toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });
    logger.info(
      `[${jobId}] Progress: ${stage}${
        subStage ? ` - ${subStage}` : ""
      } (${value}%)`,
      progress
    );
  }

  private async getCachedAsset(
    cacheKey: string,
    type: "runway" | "map" | "webp"
  ): Promise<string | null> {
    const cached = await this.assetCacheService.getCachedAsset(cacheKey);
    return cached?.path || null;
  }

  private async cacheAsset(
    jobId: string, // Add jobId parameter
    cacheKey: string,
    path: string,
    type: "runway" | "map" | "webp"
  ): Promise<void> {
    let fileBuffer: Buffer;
    let tempPath: string | undefined;

    // Check if the path is an S3 URL
    if (path.startsWith("https://") || path.startsWith("s3://")) {
      // Generate a unique temporary file path
      tempPath = this.getTempPath("OUTPUT", `${crypto.randomUUID()}.tmp`);
      await this.resourceManager.trackResource(tempPath);

      try {
        // Download the S3 file to the temporary local path
        await this.s3Service.downloadFile(path, tempPath);
        logger.debug(`[${jobId}] Downloaded S3 file for caching`, {
          s3Url: path,
          tempPath,
        });

        // Read the downloaded file into a buffer
        fileBuffer = await fs.readFile(tempPath);
      } catch (error) {
        logger.error(`[${jobId}] Failed to download S3 file for caching`, {
          s3Url: path,
          tempPath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      } finally {
        // Clean up the temporary file
        if (tempPath && existsSync(tempPath)) {
          await fs.unlink(tempPath).catch((err) => {
            logger.warn(`[${jobId}] Failed to cleanup temp file`, {
              path: tempPath,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          });
        }
      }
    } else {
      // For local paths, use the existing logic
      try {
        fileBuffer = await fs.readFile(path);
      } catch (error) {
        logger.error(`[${jobId}] Failed to read local file for caching`, {
          path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      }
    }

    // Cache the asset with the buffer
    await this.assetCacheService.cacheAsset({
      type,
      path,
      cacheKey,
      metadata: {
        timestamp: new Date(),
        settings: {},
        hash: crypto.createHash("md5").update(fileBuffer).digest("hex"),
      },
    });

    logger.info(`[${jobId}] Cached asset successfully`, {
      cacheKey,
      type,
      path,
    });
  }

  private async validateRunwayVideo(
    s3Url: string,
    index: number,
    jobId: string
  ): Promise<ValidationResult> {
    const tempPath = path.join(
      process.cwd(),
      "temp",
      `${jobId}_validate_${index}_${crypto.randomUUID()}.mp4` // Unique temp path
    );
    await this.resourceManager.trackResource(tempPath);

    try {
      const s3Key = this.getS3KeyFromUrl(s3Url);
      const exists = await this.verifyS3Asset(s3Key);
      if (!exists) {
        return {
          success: false,
          error: `Generated video not accessible at ${s3Url}`,
        };
      }

      await this.s3Service.downloadFile(s3Url, tempPath);
      await new Promise((r) => setTimeout(r, 500)); // Ensure file write completes

      // Initial validation
      let duration = await videoProcessingService.getVideoDuration(tempPath);
      let isValid = await videoProcessingService.validateVideoIntegrity(
        tempPath
      );
      let finalPath = tempPath;

      // Repair if invalid
      if (duration <= 0 || !isValid) {
        logger.warn(`[${jobId}] Initial validation failed, attempting repair`, {
          s3Url,
          index,
          duration,
          isValid,
        });
        const repairedPath = path.join(
          process.cwd(),
          "temp",
          `${jobId}_repaired_${index}_${crypto.randomUUID()}.mp4`
        );
        await this.resourceManager.trackResource(repairedPath);

        try {
          // Use default timeout and maxRetries for repair operations
          const timeout = 60000; // 60 seconds for repair
          const maxRetries = 2; // 2 retries for repair

          await ffmpegQueueManager.enqueueJob(
            () => {
              return new Promise<void>((resolve, reject) => {
                ffmpeg(tempPath)
                  .outputOptions([
                    "-c:v",
                    "copy",
                    "-c:a",
                    "copy",
                    "-map",
                    "0",
                    "-f",
                    "mp4",
                  ])
                  .output(repairedPath)
                  .on("end", () => resolve())
                  .on("error", (err) => reject(err))
                  .run();
              });
            },
            timeout,
            maxRetries
          );

          finalPath = repairedPath;
          duration = await videoProcessingService.getVideoDuration(
            repairedPath
          );
          isValid = await videoProcessingService.validateVideoIntegrity(
            repairedPath
          );

          logger.info(`[${jobId}] Video repaired successfully`, {
            s3Url,
            index,
            original: tempPath,
            repaired: repairedPath,
          });
        } catch (repairError) {
          logger.warn(`[${jobId}] Repair attempt failed`, {
            s3Url,
            index,
            error:
              repairError instanceof Error
                ? repairError.message
                : "Unknown error",
          });
        }
      }

      if (duration <= 0) {
        return {
          success: false,
          error: `Invalid video duration (${duration}s) from Runway output`,
        };
      }
      if (!isValid) {
        return {
          success: false,
          error: "Video file integrity check failed",
        };
      }

      return { success: true, duration };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      // Delayed cleanup to avoid race conditions
      if (existsSync(tempPath)) {
        await fs.unlink(tempPath).catch((error) => {
          logger.warn(`[${jobId}] Failed to cleanup validation file`, {
            path: tempPath,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        });
      }
    }
  }

  private async retryRunwayGeneration(
    inputUrl: string,
    index: number,
    listingId: string,
    jobId: string,
    attempt = 1
  ): Promise<RunwayGenerationResult | null> {
    try {
      const result = await runwayService.generateVideo(
        inputUrl,
        index,
        listingId,
        jobId
      );
      return {
        s3Url: result,
        duration: 5, // RunwayML gen3a_turbo default duration
        validated: true,
      };
    } catch (error) {
      logger.warn(`[${jobId}] Runway generation failed`, {
        attempt,
        error,
        inputUrl,
        index,
      });

      if (attempt < this.MAX_RUNWAY_RETRIES) {
        const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.retryRunwayGeneration(
          inputUrl,
          index,
          listingId,
          jobId,
          attempt + 1
        );
      }

      throw error;
    }
  }

  private async processRunwayVideos(
    jobId: string,
    inputFiles: string[],
    options?: {
      isRegeneration?: boolean;
      forceRegeneration?: boolean;
      regenerationContext?: RegenerationContext;
    }
  ): Promise<string[]> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { listingId: true, metadata: true },
    });
    if (!job?.listingId) throw new Error("Job or listingId not found");

    logger.info(`[${jobId}] Processing ${inputFiles.length} runway videos`, {
      indices: inputFiles.map((_, i) => i),
      isRegeneration: options?.isRegeneration,
      forceRegeneration: options?.forceRegeneration,
      activeFFmpegJobs: ffmpegQueueManager.getActiveCount(),
    });

    const verifyRunwayVideo = async (order: number): Promise<boolean> => {
      const photo = await this.prisma.photo.findFirst({
        where: { listingId: job.listingId, order },
        select: { runwayVideoPath: true },
      });
      return !!photo?.runwayVideoPath;
    };

    const retryRunway = async (
      inputUrl: string,
      index: number
    ): Promise<string | null> => {
      const existingVideo = await verifyRunwayVideo(index);
      if (existingVideo && !options?.forceRegeneration) {
        const photo = await this.prisma.photo.findFirst({
          where: { listingId: job.listingId, order: index },
          select: { runwayVideoPath: true },
        });
        return photo?.runwayVideoPath || null;
      }

      // Enqueue the FFmpeg job via FFmpegQueueManager
      // Use longer timeout for Runway generation which can be resource-intensive
      const timeout = 180000; // 3 minutes for Runway generation
      const maxRetries = 3; // 3 retries for Runway generation

      const result = await ffmpegQueueManager.enqueueJob(
        () => this.retryRunwayGeneration(inputUrl, index, job.listingId, jobId),
        timeout,
        maxRetries
      );

      return result?.s3Url || null;
    };

    const isRegeneration = options?.isRegeneration ?? false;
    const forceRegeneration = options?.forceRegeneration ?? false;
    const regenerationContext = options?.regenerationContext;

    logger.info(`[${jobId}] Processing runway videos`, {
      isRegeneration,
      forceRegeneration,
      photoIds: regenerationContext?.photosToRegenerate?.map((p) => p.id),
      listingId: job.listingId,
    });

    const allPhotos = await this.prisma.photo.findMany({
      where: { listingId: job.listingId },
      select: {
        id: true,
        order: true,
        runwayVideoPath: true,
        status: true,
        processedFilePath: true,
        filePath: true,
      },
      orderBy: { order: "asc" },
    });

    logger.debug(`[${jobId}] Found photos for listing`, {
      photoCount: allPhotos.length,
      photosWithRunway: allPhotos.filter((p) => p.runwayVideoPath).length,
    });

    if (isRegeneration && regenerationContext) {
      const { photosToRegenerate, existingPhotos } = regenerationContext;

      const maxOrder = Math.max(
        ...existingPhotos.map((p) => p.order),
        inputFiles.length - 1
      );
      const existingRunwayVideos: ({ order: number; path: string } | null)[] =
        new Array(maxOrder + 1).fill(null);
      existingPhotos
        .filter((photo) => photo.runwayVideoPath)
        .forEach((photo) => {
          if (photo.order <= maxOrder) {
            existingRunwayVideos[photo.order] = {
              order: photo.order,
              path: photo.runwayVideoPath as string,
            };
          }
        });

      logger.info(`[${jobId}] Starting regeneration with existing videos`, {
        existingVideosCount: existingRunwayVideos.filter((v) => v).length,
        photosToRegenerateCount: photosToRegenerate.length,
      });

      for (const photo of photosToRegenerate) {
        if (!photo.processedFilePath) {
          throw new Error(
            `Missing processedFilePath for photo order ${photo.order}`
          );
        }

        const newVideo = await retryRunway(
          photo.processedFilePath,
          photo.order
        );
        if (!newVideo) {
          throw new Error(
            `Failed to regenerate video for photo order ${photo.order}`
          );
        }

        existingRunwayVideos[photo.order] = {
          order: photo.order,
          path: newVideo,
        };
        logger.info(`[${jobId}] Replaced video at order ${photo.order}`, {
          newPath: newVideo,
        });
      }

      const validVideos = existingRunwayVideos.filter(
        (v): v is { order: number; path: string } => !!v
      );
      if (validVideos.length < inputFiles.length) {
        throw new Error(
          `Missing videos after regeneration: expected ${inputFiles.length}, got ${validVideos.length}`
        );
      }

      logger.info(`[${jobId}] Regeneration complete`, {
        totalVideos: validVideos.length,
        regeneratedCount: photosToRegenerate.length,
      });

      return validVideos.map((v) => v.path);
    }

    return this.handleNormalProcessing(
      inputFiles,
      jobId,
      job.listingId,
      allPhotos,
      new Map(
        allPhotos
          .filter((p) => p.runwayVideoPath)
          .map((p) => [p.order, p.runwayVideoPath!])
      )
    );
  }

  private async processVisionImageFallback(
    s3Key: string,
    order: number,
    jobId: string,
    listingId: string
  ): Promise<string | null> {
    try {
      const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
      const s3Url = `https://${bucket}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${s3Key}`;

      const { Body } = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: s3Key,
        })
      );

      if (!Body) {
        throw new Error(`No body in S3 response for file: ${s3Key}`);
      }

      const inputBuffer = await streamToBuffer(Body as Readable);
      const cropCoords = await this.visionProcessor.analyzeImageForCrop(
        inputBuffer
      );

      const processedKey = `properties/${listingId}/images/processed/${jobId}/vision_${order}.webp`;
      const sharpStream = sharp(inputBuffer)
        .extract({
          left: cropCoords.x,
          top: cropCoords.y,
          width: cropCoords.width,
          height: cropCoords.height,
        })
        .resize({
          width: this.IMAGE_OPTIMIZATION_OPTIONS.width,
          height: this.IMAGE_OPTIMIZATION_OPTIONS.height,
          fit: this.IMAGE_OPTIMIZATION_OPTIONS.fit,
        })
        .webp({ quality: this.IMAGE_OPTIMIZATION_OPTIONS.quality });

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucket,
          Key: processedKey,
          Body: sharpStream,
          ContentType: "image/webp",
        },
      });

      await upload.done();
      const processedUrl = `https://${bucket}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${processedKey}`;

      // Verify the upload was successful
      const exists = await this.verifyS3Asset(processedKey);
      if (!exists) {
        throw new Error(`Uploaded image not accessible at ${processedUrl}`);
      }

      // Update Photo record
      await this.prisma.photo.updateMany({
        where: { listingId, order },
        data: {
          processedFilePath: processedUrl,
          status: "COMPLETED",
          updatedAt: new Date(),
          metadata: {
            visionProcessedAt: new Date().toISOString(),
            isReprocessed: true,
          },
        },
      });

      return processedUrl;
    } catch (error) {
      logger.error(`[${jobId}] Fallback vision processing failed`, {
        s3Key,
        order,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  private getS3UrlFromKey(key: string): string {
    // Ensure the key doesn't start with a slash
    const sanitizedKey = key.startsWith("/") ? key.substring(1) : key;

    // Construct a proper URL with protocol and hostname
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${sanitizedKey}`;
  }

  private getS3KeyFromUrl(url: string): string {
    try {
      // Parse the URL properly
      const parsedUrl = new URL(url);

      // Extract the path and remove leading slash if present
      let path = parsedUrl.pathname;
      if (path.startsWith("/")) {
        path = path.substring(1);
      }

      return path;
    } catch (error) {
      // If URL parsing fails, try to extract the path portion after the bucket name
      const bucketPattern = new RegExp(
        `https?://${this.bucket}.s3.${this.region}.amazonaws.com/(.*)`
      );
      const match = url.match(bucketPattern);

      if (match && match[1]) {
        return match[1];
      }

      // If all else fails, return the original URL (though this may cause issues)
      console.warn(`Failed to parse S3 URL: ${url}`);
      return url;
    }
  }

  private validateS3Url(url: string): string {
    if (!url) {
      throw new Error("Empty S3 URL provided");
    }

    try {
      // Validate URL format
      new URL(url);
      return url;
    } catch (error) {
      // If it's not a valid URL, try to construct one
      if (url.startsWith("s3://")) {
        // Handle s3:// protocol format
        const path = url.substring(5);
        return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${path}`;
      } else if (!url.startsWith("http")) {
        // Treat as a key if it doesn't start with http
        return this.getS3UrlFromKey(url);
      }

      throw new Error(`Invalid S3 URL format: ${url}`);
    }
  }

  private async verifyS3Asset(s3Key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: process.env.AWS_BUCKET || "reelty-prod-storage",
        Key: s3Key,
      });
      const response = await this.s3Client.send(command);
      return response.ContentLength !== undefined && response.ContentLength > 0;
    } catch (error) {
      if (
        error instanceof Error &&
        "name" in error &&
        error.name === "NotFound"
      ) {
        return false;
      }
      throw error;
    }
  }

  private async verifyS3VideoAccess(
    path: string,
    jobId: string,
    retries = 3
  ): Promise<string | null> {
    // First check if this is a local file path
    if (path.startsWith("/") && !path.startsWith("//")) {
      try {
        // Check if the file exists locally
        const exists = existsSync(path);
        if (exists) {
          logger.info(`[${jobId}] Video verified accessible as local file`, {
            path,
            verificationTime: 0,
          });
          return path;
        } else {
          logger.warn(`[${jobId}] Local file not accessible`, {
            path,
          });
          return null;
        }
      } catch (error) {
        logger.warn(`[${jobId}] Error checking local file accessibility`, {
          path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return null;
      }
    }

    const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
    const s3Key = this.getS3KeyFromUrl(path);
    const MAX_TIMEOUT = 60000; // Increased from 30s to 60s total timeout
    const startTime = Date.now();

    logger.debug(`[${jobId}] Verifying S3 video access`, {
      originalPath: path,
      extractedKey: s3Key,
      bucket: bucketName,
    });

    // First try using our more robust waitForS3ObjectAvailability method
    const isAvailable = await this.waitForS3ObjectAvailability(s3Key, jobId, 3);
    if (isAvailable) {
      logger.info(
        `[${jobId}] Video verified accessible using waitForS3ObjectAvailability`,
        {
          path,
          s3Key,
          verificationTime: Date.now() - startTime,
        }
      );
      return path;
    }

    // If that fails, fall back to the original retry logic
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Check if we've exceeded the total timeout
        if (Date.now() - startTime > MAX_TIMEOUT) {
          logger.error(`[${jobId}] S3 verification timeout exceeded`, {
            path,
            maxTimeout: MAX_TIMEOUT,
          });
          return null;
        }

        // Use HEAD request to verify file existence and metadata
        const exists = await this.s3VideoService.verifyS3FileWithRetries(
          bucketName,
          s3Key,
          2 // Use 2 internal retries for each main retry attempt
        );

        if (exists) {
          logger.info(`[${jobId}] Video verified accessible`, {
            path,
            attempt,
            s3Key,
            verificationTime: Date.now() - startTime,
          });
          return path;
        }

        logger.warn(`[${jobId}] Video not yet accessible, retrying`, {
          path,
          attempt,
          s3Key,
          elapsed: Date.now() - startTime,
        });

        if (attempt < retries - 1) {
          // Enhanced exponential backoff with longer initial delay (2s instead of 1s)
          const delay = Math.min(
            2000 * Math.pow(2, attempt) * (0.5 + Math.random()),
            MAX_TIMEOUT - (Date.now() - startTime) // Don't wait longer than remaining timeout
          );

          if (delay <= 0) {
            logger.warn(`[${jobId}] Skipping retry due to timeout`, {
              path,
              attempt,
              elapsed: Date.now() - startTime,
            });
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        logger.warn(`[${jobId}] Error checking video accessibility`, {
          path,
          attempt,
          s3Key,
          error: error instanceof Error ? error.message : "Unknown error",
          elapsed: Date.now() - startTime,
        });

        if (attempt < retries - 1 && Date.now() - startTime < MAX_TIMEOUT) {
          const delay = Math.min(
            2000 * Math.pow(2, attempt) * (0.5 + Math.random()),
            MAX_TIMEOUT - (Date.now() - startTime)
          );

          if (delay <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(`[${jobId}] Video inaccessible after retries`, {
      path,
      s3Key,
      totalTime: Date.now() - startTime,
    });

    // Ensure we always return a value
    return null;
  }

  private async processTemplate(
    template: TemplateKey,
    runwayVideos: string[],
    jobId: string,
    listingId: string,
    coordinates?: { lat: number; lng: number },
    mapVideo?: string | null
  ): Promise<TemplateProcessingResult> {
    const startTime = Date.now();
    const tempDir = path.join(process.cwd(), "temp", `${jobId}_${template}`);
    const templateConfig = reelTemplates[template];
    const outputPath = path.join(tempDir, `${template}.mp4`);

    try {
      await fs.mkdir(tempDir, { recursive: true });

      // Create clips array with proper handling for map video
      let clips: VideoClip[] = [];

      // Special handling for googlezoomintro template
      if (template === "googlezoomintro") {
        if (!mapVideo) {
          logger.warn(
            `[${jobId}] Map video missing for googlezoomintro template`,
            {
              coordinates,
              hasMapVideo: !!mapVideo,
            }
          );
          // Continue without map video, using only runway videos
          clips = runwayVideos.map((path, i) => ({
            path,
            duration: Array.isArray(templateConfig.durations)
              ? templateConfig.durations[i] || 5
              : (templateConfig.durations as Record<string | number, number>)[
                  i + 1
                ] || 5,
            colorCorrection: templateConfig.colorCorrection,
          }));
        } else {
          // Validate map video before using it
          const isMapValid = await this.validateMapVideo(mapVideo, jobId);
          if (!isMapValid) {
            logger.warn(
              `[${jobId}] Map video validation failed, proceeding without map`,
              {
                mapVideoPath: mapVideo,
              }
            );
            // Continue without map video
            clips = runwayVideos.map((path, i) => ({
              path,
              duration: Array.isArray(templateConfig.durations)
                ? templateConfig.durations[i] || 5
                : (templateConfig.durations as Record<string | number, number>)[
                    i + 1
                  ] || 5,
              colorCorrection: templateConfig.colorCorrection,
            }));
          } else {
            // Map video is valid, add it as first clip
            clips = [
              {
                path: mapVideo,
                duration: (templateConfig.durations as any)?.map || 3,
                isMapVideo: true,
              },
              ...runwayVideos.map((path, i) => ({
                path,
                duration: Array.isArray(templateConfig.durations)
                  ? templateConfig.durations[i] || 5
                  : (
                      templateConfig.durations as Record<
                        string | number,
                        number
                      >
                    )[i + 1] || 5,
                colorCorrection: templateConfig.colorCorrection,
              })),
            ];

            logger.info(
              `[${jobId}] Successfully added map video to googlezoomintro template`,
              {
                mapVideoPath: mapVideo,
                totalClips: clips.length,
              }
            );
          }
        }
      } else if (template.toLowerCase() === "wesanderson") {
        clips = runwayVideos.map((path, i) => ({
          path,
          duration: Array.isArray(templateConfig.durations)
            ? templateConfig.durations[i] || 5
            : (templateConfig.durations as Record<string | number, number>)[
                i
              ] || 5,
          colorCorrection: templateConfig.colorCorrection,
        }));

        // Pre-process Wes Anderson clips - use VideoProcessingService instead
        clips = await Promise.all(
          clips.map((clip, i) =>
            videoProcessingService.preProcessWesAndersonClip(clip, i, jobId)
          )
        );
      } else {
        // For other templates, properly map sequence to available videos
        const templateSequence = templateConfig.sequence;

        // Create a mapping of available videos by index
        const availableVideos = new Map<number | string, string>();
        runwayVideos.forEach((path, index) => {
          availableVideos.set(index, path);
        });

        // If we have a map video, add it to available videos
        if (mapVideo && template.toLowerCase().includes("googlezoomintro")) {
          availableVideos.set("map", mapVideo);
        }

        // Log available resources
        logger.info(`[${jobId}] Available resources for template ${template}`, {
          availableVideoCount: runwayVideos.length,
          hasMapVideo: !!mapVideo,
          sequenceLength: templateSequence.length,
        });

        // Create clips by mapping sequence to available videos
        const validClips: VideoClip[] = [];
        let durationIndex = 0;

        // First pass: try to follow the sequence
        for (const seqItem of templateSequence) {
          const videoPath = availableVideos.get(seqItem);
          if (!videoPath) {
            continue; // Skip if video not available
          }

          // Get the appropriate duration
          let duration = templateConfig.durations[durationIndex] || 2.5;

          // Add to valid clips
          validClips.push({
            path: videoPath,
            duration,
            colorCorrection: templateConfig.colorCorrection,
            isMapVideo: seqItem === "map",
          });

          durationIndex++;

          // If we have enough clips to match all durations, we can stop
          if (durationIndex >= templateConfig.durations.length) {
            break;
          }
        }

        // Second pass: if we don't have enough clips, use any available videos
        // This ensures we have at least 10 clips for the 10 durations
        if (
          validClips.length < templateConfig.durations.length &&
          availableVideos.size > 0
        ) {
          logger.info(
            `[${jobId}] Not enough clips from sequence (${validClips.length}/${templateConfig.durations.length}), adding additional clips`,
            {
              validClipsCount: validClips.length,
              requiredClipsCount: templateConfig.durations.length,
              availableVideosCount: availableVideos.size,
            }
          );

          // Get all available video indices that weren't used yet
          const usedIndices = new Set(
            templateSequence.slice(0, validClips.length)
          );
          const remainingIndices = Array.from(availableVideos.keys()).filter(
            (key) => !usedIndices.has(key) && key !== "map"
          );

          // Add remaining videos until we have enough clips
          for (const index of remainingIndices) {
            if (durationIndex >= templateConfig.durations.length) {
              break; // We have enough clips
            }

            const videoPath = availableVideos.get(index);
            if (!videoPath) {
              continue;
            }

            // Get the appropriate duration
            let duration = templateConfig.durations[durationIndex] || 2.5;

            // Add to valid clips
            validClips.push({
              path: videoPath,
              duration,
              colorCorrection: templateConfig.colorCorrection,
              isMapVideo: false,
            });

            durationIndex++;
          }
        }

        logger.info(
          `[${jobId}] Created ${validClips.length} valid clips for template ${template}`,
          {
            requestedDurations: templateConfig.durations.length,
            actualClips: validClips.length,
          }
        );

        // Assign validClips to clips for further processing
        clips = validClips;
      }

      // After creating clips, add this check:
      if (clips.length === 0) {
        logger.warn(
          `[${jobId}] No valid clips created for template ${template}`,
          {
            availableVideos: runwayVideos.length,
            templateSequence: templateConfig.sequence.length,
          }
        );
        return {
          template,
          status: "FAILED",
          outputPath: null,
          error: "No valid clips available for template",
        };
      }

      if (
        Array.isArray(templateConfig.durations) &&
        clips.length < templateConfig.durations.length
      ) {
        logger.warn(`[${jobId}] Not enough clips for template ${template}`, {
          expected: templateConfig.durations.length,
          actual: clips.length,
        });
      }

      // Replace stitchVideos with stitchVideoClips and pass the template configuration
      await videoProcessingService.stitchVideoClips(
        clips,
        outputPath,
        templateConfig,
        undefined // No watermark config
      );

      try {
        // Verify the video was created successfully
        const verifiedUrl = await this.retryWithBackoff(
          async () => {
            // Check if the file exists and is a valid video
            if (!(await this.fileExists(outputPath))) {
              throw new Error(`Video file not found at ${outputPath}`);
            }

            // Fix the S3 path construction before uploading
            const s3Path = `properties/${listingId}/videos/templates/${template}/${template}.mp4`;

            // Ensure we're passing a properly formatted S3 path, not trying to construct a URL here
            const url = await this.retryWithBackoff(
              async () => {
                logger.info(`[${jobId}] Uploading template ${template} to S3`, {
                  template,
                  listingId,
                  localPath: outputPath,
                });

                // Pass the path components separately instead of a pre-constructed URL
                return this.s3VideoService.uploadVideo(outputPath, s3Path, {
                  contentType: "video/mp4",
                  metadata: {
                    jobId,
                    template,
                    listingId,
                  },
                });
              },
              this.MAX_RETRIES,
              `Video creation for ${template}`,
              jobId
            );

            // Add debug logging to see the returned URL
            logger.debug(`[${jobId}] Uploaded video URL: ${url}`);

            // Verify the uploaded file is accessible
            const uploadedS3Key = this.getS3KeyFromUrl(url);
            const isAvailable = await this.waitForS3ObjectAvailability(
              uploadedS3Key,
              jobId,
              5
            );

            if (!isAvailable) {
              throw new Error(
                `Uploaded video not accessible at ${url} after extended verification`
              );
            }

            // Clean up local file after successful upload
            try {
              await fs.unlink(outputPath);
              logger.info(
                `[${jobId}] Cleaned up local template file after S3 upload`,
                {
                  template,
                  localPath: outputPath,
                }
              );
            } catch (cleanupError) {
              logger.warn(`[${jobId}] Failed to clean up local template file`, {
                template,
                localPath: outputPath,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              });
            }

            // Return the S3 URL
            return url;
          },
          this.MAX_RETRIES,
          `Video creation for ${template}`,
          jobId
        );

        return {
          template,
          status: "SUCCESS",
          outputPath: verifiedUrl,
          processingTime: Date.now() - startTime,
        };
      } catch (verificationError) {
        // If verification fails, but we have successfully processed the clips,
        // use a fallback strategy - return a photo URL instead of video
        logger.warn(
          `[${jobId}] Video creation for ${template} failed verification, using fallback`,
          {
            error:
              verificationError instanceof Error
                ? verificationError.message
                : String(verificationError),
          }
        );

        // Get a sample photo from the first available video path
        const fallbackPhotoUrl = runwayVideos[0]
          ?.replace("/videos/runway/", "/images/processed/")
          .replace(".mp4", ".webp");

        if (fallbackPhotoUrl) {
          return {
            template,
            status: "SUCCESS",
            outputPath: fallbackPhotoUrl,
            processingTime: Date.now() - startTime,
            usedFallback: true,
          };
        }

        // If we can't even create a fallback, then throw the error
        throw verificationError;
      }
    } catch (error) {
      logger.error(`[${jobId}] Error processing template ${template}`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Clean up local file in case of error
      try {
        if (await this.fileExists(outputPath)) {
          await fs.unlink(outputPath);
          logger.info(`[${jobId}] Cleaned up local template file after error`, {
            template,
            localPath: outputPath,
          });
        }
      } catch (cleanupError) {
        logger.warn(
          `[${jobId}] Failed to clean up local template file after error`,
          {
            template,
            localPath: outputPath,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          }
        );
      }

      return {
        template,
        status: "FAILED",
        outputPath: null,
        error: error instanceof Error ? error.message : String(error),
        processingTime: Date.now() - startTime,
      };
    }
  }

  // Helper method to check if file exists
  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async processTemplatesForSpecific(
    runwayVideos: string[],
    jobId: string,
    listingId: string,
    templates: TemplateKey[],
    coordinates?: { lat: number; lng: number },
    mapVideo?: string | null
  ): Promise<string[]> {
    const results: string[] = [];
    const processedTemplates: {
      key: string;
      path: string;
      usedFallback?: boolean;
    }[] = [];

    try {
      const isRegeneration = await this.isRegeneration(jobId); // Helper to check job metadata
      const BATCH_SIZE = this.getDefaultBatchSize(isRegeneration);

      // Improved detection of map-dependent templates
      const mapDependentTemplates = templates.filter((t) => {
        const template = reelTemplates[t];
        return (
          Array.isArray(template.sequence) &&
          (template.sequence.includes("map") || t === "googlezoomintro")
        );
      });

      const regularTemplates = templates.filter(
        (t) => !mapDependentTemplates.includes(t)
      );

      logger.info(`[${jobId}] Template processing plan`, {
        mapDependentTemplates,
        regularTemplates,
        hasCoordinates: !!coordinates,
        hasMapVideo: !!mapVideo,
      });

      if (mapDependentTemplates.length > 0) {
        if (!coordinates) {
          logger.warn(
            `[${jobId}] Map-dependent templates requested but no coordinates provided`,
            {
              templates: mapDependentTemplates,
            }
          );
          templates = regularTemplates;
        } else if (!mapVideo) {
          try {
            logger.info(`[${jobId}] Generating map video for templates`, {
              templates: mapDependentTemplates,
              coordinates,
            });
            mapVideo = await this.generateMapVideoForTemplate(
              coordinates,
              jobId,
              listingId
            );

            // Validate the generated map video
            if (mapVideo) {
              const isValid = await this.validateMapVideo(mapVideo, jobId);
              if (!isValid) {
                logger.warn(
                  `[${jobId}] Generated map video failed validation`,
                  {
                    mapVideoPath: mapVideo,
                  }
                );
                mapVideo = null;
              } else {
                logger.info(
                  `[${jobId}] Map video generated and validated successfully`,
                  {
                    mapVideoPath: mapVideo,
                  }
                );
              }
            }

            if (!mapVideo) {
              logger.warn(
                `[${jobId}] Map video generation failed or validation failed, will process templates without map`,
                {
                  coordinates,
                }
              );
              // We'll still process map-dependent templates, but they'll handle the missing map video
            }
          } catch (error) {
            logger.error(`[${jobId}] Failed to generate map video`, {
              error: error instanceof Error ? error.message : String(error),
              coordinates,
            });
            // We'll still process map-dependent templates, but they'll handle the missing map video
          }
        }
      }

      // Process all templates serially with a delay
      for (let i = 0; i < regularTemplates.length; i += BATCH_SIZE) {
        const batch = regularTemplates.slice(i, i + BATCH_SIZE);

        logger.info(
          `[${jobId}] Processing regular template batch ${i / BATCH_SIZE + 1}`,
          {
            templates: batch,
            batchSize: batch.length,
            isRegeneration,
          }
        );

        for (const template of batch) {
          try {
            const result = await this.processTemplate(
              template,
              runwayVideos,
              jobId,
              listingId,
              coordinates,
              mapVideo
            );

            if (result.status === "SUCCESS" && result.outputPath) {
              results.push(result.outputPath);
              processedTemplates.push({
                key: template,
                path: result.outputPath,
                usedFallback: result.usedFallback,
              });

              logger.info(`[${jobId}] Processed template ${template}`, {
                outputPath: result.outputPath,
                processingTime: result.processingTime,
                usedFallback: result.usedFallback,
              });
            } else {
              logger.warn(`[${jobId}] Failed to process template ${template}`, {
                error: result.error,
              });

              // Even if a template fails, we'll continue with the rest
              if (result.error?.includes("not accessible") && runwayVideos[0]) {
                // Use first image as fallback for template thumbnail
                const fallbackPhotoUrl = runwayVideos[0]
                  .replace("/videos/runway/", "/images/processed/")
                  .replace(".mp4", ".webp");
                processedTemplates.push({
                  key: template,
                  path: fallbackPhotoUrl,
                  usedFallback: true,
                });
                logger.info(
                  `[${jobId}] Using fallback image for template ${template}`,
                  {
                    fallbackPhotoUrl,
                  }
                );
              }
            }
          } catch (error) {
            logger.error(`[${jobId}] Error processing template ${template}`, {
              error: error instanceof Error ? error.message : String(error),
            });
            // Continue processing other templates even if this one failed
          }

          // Delay between individual templates, increased for regeneration
          if (
            i + BATCH_SIZE < regularTemplates.length ||
            mapDependentTemplates.length > 0
          ) {
            const delay = isRegeneration ? 3000 : 2000; // 3s for regeneration, 2s otherwise
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Process map-dependent templates
      if (mapDependentTemplates.length > 0) {
        logger.info(`[${jobId}] Processing map-dependent templates`, {
          templates: mapDependentTemplates,
          mapVideoPath: mapVideo || "No map video available",
        });

        // Process map-dependent templates one at a time
        for (const template of mapDependentTemplates) {
          try {
            logger.info(`[${jobId}] Processing map template: ${template}`, {
              mapVideo: mapVideo || "No map video available",
              runwayVideosCount: runwayVideos.length,
            });

            const result = await this.processTemplate(
              template,
              runwayVideos,
              jobId,
              listingId,
              coordinates,
              mapVideo
            );

            if (result.status === "SUCCESS" && result.outputPath) {
              results.push(result.outputPath);
              processedTemplates.push({
                key: template,
                path: result.outputPath,
                usedFallback: result.usedFallback,
              });

              logger.info(`[${jobId}] Map template processed successfully`, {
                template,
                processingTime: result.processingTime,
                usedFallback: result.usedFallback,
              });
            } else {
              logger.warn(`[${jobId}] Map template processing failed`, {
                template,
                error:
                  result.error || "Unknown error in map template processing",
              });

              // Even if a template fails, we'll continue with the rest
              if (result.error?.includes("not accessible") && runwayVideos[0]) {
                // Use first image as fallback for template thumbnail
                const fallbackPhotoUrl = runwayVideos[0]
                  .replace("/videos/runway/", "/images/processed/")
                  .replace(".mp4", ".webp");
                processedTemplates.push({
                  key: template,
                  path: fallbackPhotoUrl,
                  usedFallback: true,
                });
                logger.info(
                  `[${jobId}] Using fallback image for map template ${template}`,
                  {
                    fallbackPhotoUrl,
                  }
                );
              }
            }
          } catch (error) {
            logger.error(
              `[${jobId}] Error processing map template ${template}`,
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
            // Continue with next template despite errors
            continue;
          }
        }
      }

      // Update the job with processed templates information
      try {
        const currentJob = await this.prisma.videoJob.findUnique({
          where: { id: jobId },
        });

        if (currentJob && currentJob.metadata) {
          const updatedMetadata = {
            ...(currentJob.metadata as Record<string, any>),
            processedTemplates,
          };

          await this.prisma.videoJob.update({
            where: { id: jobId },
            data: {
              metadata: updatedMetadata,
            },
          });

          logger.info(
            `[${jobId}] Updated job metadata with processed templates info`,
            {
              templatesCount: processedTemplates.length,
            }
          );
        }
      } catch (metadataError) {
        logger.warn(
          `[${jobId}] Failed to update job metadata with templates info`,
          {
            error:
              metadataError instanceof Error
                ? metadataError.message
                : String(metadataError),
          }
        );
      }

      return results;
    } catch (error) {
      logger.error(`[${jobId}] Error in template processing`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Even if we have an error, return any results we've collected so far
      return results;
    }
  }

  private async processVisionImages(jobId: string): Promise<ProcessingImage[]> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        listingId: true,
        metadata: true,
        inputFiles: true,
        userId: true,
      },
    });

    if (!job?.listingId) {
      logger.error(`[${jobId}] Job not found or missing listingId`);
      throw new Error("Job or listingId not found");
    }

    const isRegeneration = (job.metadata as any)?.isRegeneration === true;
    const regenerationContext = (job.metadata as any)?.regenerationContext;

    // Define results variable outside try/catch to fix scope issue
    let results: PromiseSettledResult<ProcessingImage>[] = [];

    try {
      if (isRegeneration && regenerationContext) {
        const { photosToRegenerate } = regenerationContext;

        results = await Promise.allSettled(
          photosToRegenerate.map(async (photo: Photo) => {
            let processedPath = photo.processedFilePath;
            if (
              !processedPath ||
              !(await this.verifyS3VideoAccess(processedPath, jobId))
            ) {
              processedPath = await this.processVisionImageFallback(
                this.getS3KeyFromUrl(photo.filePath),
                photo.order,
                jobId,
                job.listingId
              );
            }

            if (!processedPath) {
              throw new Error(`Failed to process image for photo ${photo.id}`);
            }

            await this.prisma.photo.update({
              where: { id: photo.id },
              data: {
                processedFilePath: processedPath,
                status: "COMPLETED",
                updatedAt: new Date(),
                metadata: {
                  visionProcessedAt: new Date().toISOString(),
                  isReprocessed: true,
                },
              },
            });

            return { order: photo.order, path: processedPath, id: photo.id };
          })
        );
      } else {
        results = await Promise.allSettled(
          (job.inputFiles as string[]).map(async (filePath, index) => {
            const s3Key = this.getS3KeyFromUrl(filePath);
            let processedPath = await this.processVisionImageFallback(
              s3Key,
              index,
              jobId,
              job.listingId
            );

            if (!processedPath) {
              throw new Error(
                `Failed to process image at index ${index}: ${filePath}`
              );
            }

            const existingPhoto = await this.prisma.photo.findFirst({
              where: { listingId: job.listingId, order: index },
            });

            await this.prisma.photo.upsert({
              where: { id: existingPhoto?.id || "" },
              update: {
                processedFilePath: processedPath,
                status: "COMPLETED",
                updatedAt: new Date(),
                metadata: { visionProcessedAt: new Date().toISOString() },
              },
              create: {
                userId: job.userId,
                listingId: job.listingId,
                order: index,
                filePath: filePath,
                s3Key: s3Key,
                processedFilePath: processedPath,
                status: "COMPLETED",
              },
            });

            return { order: index, path: processedPath };
          })
        );
      }

      const processedImages = results
        .filter(
          (r): r is PromiseFulfilledResult<ProcessingImage> =>
            r.status === "fulfilled"
        )
        .map((r) => r.value);
      const failures = results.filter((r) => r.status === "rejected");

      if (failures.length > 0) {
        await this.updateJobProgress(jobId, {
          stage: "vision",
          progress: (processedImages.length / results.length) * 100,
          message: `Processed ${processedImages.length}/${results.length} images`,
          error: `Failed to process ${failures.length} images`,
        });
        logger.warn(`[${jobId}] Some images failed processing`, {
          failedCount: failures.length,
          reasons: failures.map(
            (f) =>
              (f as PromiseRejectedResult).reason?.message || "Unknown error"
          ),
          indices: isRegeneration
            ? regenerationContext.photosToRegenerate
                .filter(
                  (p: Photo, index: number) =>
                    results[index].status === "rejected"
                )
                .map((p: Photo) => p.id)
            : (job.inputFiles as string[])
                .filter(
                  (_, index: number) => results[index].status === "rejected"
                )
                .map((_, index: number) => index),
        });
      } else {
        await this.updateJobProgress(jobId, {
          stage: "vision",
          progress: 100,
          message: "All images processed successfully",
        });
      }

      if (processedImages.length === 0) {
        throw new Error("All image processing attempts failed");
      }

      return processedImages;
    } catch (error) {
      logger.error(`[${jobId}] Failed to process vision images`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        isRegeneration,
      });

      if (
        results.some(
          (r: PromiseSettledResult<ProcessingImage>) => r.status === "fulfilled"
        )
      ) {
        const partialResults = results
          .filter(
            (
              r: PromiseSettledResult<ProcessingImage>
            ): r is PromiseFulfilledResult<ProcessingImage> =>
              r.status === "fulfilled"
          )
          .map((r: PromiseFulfilledResult<ProcessingImage>) => r.value);
        await this.updateJobProgress(jobId, {
          stage: "vision",
          progress: (partialResults.length / results.length) * 100,
          message: `Partially processed ${partialResults.length}/${results.length} images`,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return partialResults;
      }

      throw error;
    }
  }

  private async cleanupStaleLocks(listingId: string): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.listingLock.deleteMany({
        where: {
          listingId,
          expiresAt: {
            lt: now,
          },
        },
      });
      return;
    } catch (error) {
      logger.warn(`Failed to cleanup stale locks for listing ${listingId}`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return;
    }
  }

  private async acquireListingLock(
    jobId: string,
    listingId: string
  ): Promise<boolean> {
    let retries = 0;
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second

    // First cleanup any stale locks
    await this.cleanupStaleLocks(listingId);

    while (retries < maxRetries) {
      try {
        // Simplified approach: use a single transaction to check and create the lock
        // This ensures atomicity and prevents race conditions
        const lock = await this.prisma.$transaction(async (tx) => {
          // Check for existing valid lock first
          const existingLock = await tx.listingLock.findFirst({
            where: {
              listingId,
              expiresAt: { gt: new Date() },
            },
          });

          if (existingLock) {
            logger.info({
              message: `[${jobId}] Listing ${listingId} has valid lock held by job ${existingLock.jobId}`,
              jobId,
              listingId,
              lockHolderId: existingLock.jobId,
            });
            return null;
          }

          // No existing lock, create a new one
          return await tx.listingLock.create({
            data: {
              listingId,
              jobId,
              processId: process.pid.toString(),
              expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
            },
          });
        });

        // If lock is null, it means another process holds the lock
        if (!lock) {
          return false;
        }

        logger.info(
          `[${jobId}] Successfully acquired lock for listing ${listingId}`,
          {
            lockId: lock.id,
            expiresAt: lock.expiresAt,
          }
        );

        return true;
      } catch (error) {
        retries++;

        // Handle unique constraint violations (another process created the lock simultaneously)
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          logger.info(
            `[${jobId}] Listing lock already exists in database (concurrent creation)`,
            {
              jobId,
              listingId,
            }
          );
          return false;
        }

        logger.warn(
          `[${jobId}] Failed to acquire listing lock (attempt ${retries}/${maxRetries})`,
          {
            error: error instanceof Error ? error.message : "Unknown error",
            jobId,
            listingId,
          }
        );

        if (retries < maxRetries) {
          // Exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelay * Math.pow(2, retries))
          );
          continue;
        }

        return false;
      }
    }

    return false;
  }

  private async releaseListingLock(
    jobId: string,
    listingId: string
  ): Promise<void> {
    try {
      // Simplified release - just delete the database lock
      const result = await this.prisma.listingLock.deleteMany({
        where: {
          listingId,
          jobId,
          processId: process.pid.toString(),
        },
      });

      logger.debug(`[${jobId}] Released listing lock`, {
        listingId,
        deletedCount: result.count,
      });
    } catch (error) {
      logger.error(`[${jobId}] Failed to release listing lock`, {
        error: error instanceof Error ? error.message : "Unknown error",
        jobId,
        listingId,
      });
      throw error;
    }
  }

  public async execute(input: ProductionPipelineInput): Promise<string> {
    const {
      jobId,
      inputFiles,
      isRegeneration,
      forceRegeneration,
      regenerationContext,
      coordinates,
      listingId: inputListingId,
    } = input;
    logger.info(`[${jobId}] Pipeline execution started`, { input });

    if (isRegeneration && regenerationContext) {
      const updatedJob = await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          metadata: {
            isRegeneration,
            forceRegeneration,
            regenerationContext: JSON.parse(
              JSON.stringify(regenerationContext)
            ),
          } satisfies Prisma.InputJsonValue,
        },
        select: { metadata: true },
      });
      logger.info(`[${jobId}] Metadata updated`, {
        metadata: updatedJob.metadata,
      });
    }

    const tempDir = path.join(process.cwd(), "temp", jobId);

    try {
      let listingId = inputListingId;
      if (!listingId) {
        const job = await this.prisma.videoJob.findUnique({
          where: { id: jobId },
          select: { listingId: true },
        });
        listingId = job?.listingId;
      }
      if (!listingId) throw new Error("listingId is required");

      if (!input.skipLock) {
        logger.info(
          `[${jobId}] Attempting to acquire lock for listing ${listingId}`
        );
        const lockAcquired = await this.acquireListingLock(jobId, listingId);
        if (!lockAcquired) {
          const errorMessage = `Failed to acquire lock for listing ${listingId}. Another job may be processing this listing.`;
          logger.warn(`[${jobId}] ${errorMessage}`);
          throw new Error(errorMessage);
        }
        logger.info(`[${jobId}] Lock acquired for listing ${listingId}`);
      } else {
        logger.info(`[${jobId}] Skipping lock acquisition as requested`);
      }

      const jobCheck = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
      });
      if (jobCheck) {
        logger.info(`[${jobId}] Job state before execution`, {
          metadata: jobCheck.metadata,
        });
      } else {
        logger.warn(`[${jobId}] Job not found before execution`);
      }

      // Vision processing - can be forced to regenerate
      await this.processWithMemoryCheck(
        jobId,
        async () => await this.processVisionImages(jobId),
        "Vision image processing"
      );

      // Runway video generation - can be forced to regenerate
      let runwayVideos: string[] = [];
      const runwayOptions = {
        isRegeneration,
        forceRegeneration,
        regenerationContext,
      };

      if (!input.skipRunwayIfCached) {
        runwayVideos = await this.processWithMemoryCheck(
          jobId,
          async () =>
            await this.retryWithBackoff(
              () => this.processRunwayVideos(jobId, inputFiles, runwayOptions),
              this.MAX_RUNWAY_RETRIES,
              "Runway video processing",
              jobId
            ),
          "Runway video generation"
        );
      } else {
        const existingVideosData = await this.getRunwayVideos(jobId);
        const existingVideos = existingVideosData.map((v) => v.path);

        if (existingVideos.length === inputFiles.length && !isRegeneration) {
          runwayVideos = existingVideos;
          logger.info(`[${jobId}] Using cached Runway videos`, {
            count: runwayVideos.length,
          });
        } else {
          runwayVideos = await this.processWithMemoryCheck(
            jobId,
            async () =>
              await this.retryWithBackoff(
                () =>
                  this.processRunwayVideos(jobId, inputFiles, runwayOptions),
                this.MAX_RUNWAY_RETRIES,
                "Runway video processing",
                jobId
              ),
            "Runway video generation"
          );
        }
      }

      runwayVideos = this.validateVideoCount(
        runwayVideos,
        inputFiles.length,
        jobId,
        !!isRegeneration
      );
      logger.debug(`[${jobId}] Runway videos generated`, { runwayVideos });

      await this.verifyResources(runwayVideos, null);

      // Map video generation - always check cache first regardless of forceRegeneration
      let mapVideo = null;
      if (coordinates && listingId) {
        // Generate a standardized cache key for map videos
        const mapCacheKey = this.generateStandardMapCacheKey(
          listingId,
          coordinates
        );

        // Always check cache first, regardless of forceRegeneration
        const cachedMapVideo = await this.getCachedAsset(mapCacheKey, "map");
        if (cachedMapVideo) {
          const isValid = await this.validateMapVideo(cachedMapVideo, jobId);
          if (isValid) {
            logger.info(
              `[${jobId}] Using cached map video regardless of forceRegeneration`,
              {
                mapCacheKey,
                cachedPath: cachedMapVideo,
                listingId,
                coordinates,
                forceRegeneration,
              }
            );
            mapVideo = this.validateS3Url(cachedMapVideo);
          } else {
            logger.warn(
              `[${jobId}] Cached map video failed validation, will regenerate`,
              {
                mapCacheKey,
                cachedPath: cachedMapVideo,
                listingId,
                coordinates,
              }
            );
          }
        }

        // Only generate if not found in cache or validation failed
        if (!mapVideo) {
          mapVideo = await this.processWithMemoryCheck(
            jobId,
            async () =>
              await this.generateMapVideoForTemplate(
                coordinates,
                jobId,
                listingId
              ),
            "Map video generation"
          );

          if (mapVideo) {
            logger.info(`[${jobId}] Generated new map video`, {
              mapCacheKey,
              path: mapVideo,
              listingId,
              coordinates,
            });
          }
        }
      }

      if (mapVideo) {
        await this.verifyResources([mapVideo], null);
      }

      // Template processing - can be forced to regenerate
      const templateResults = await this.processWithMemoryCheck(
        jobId,
        async () =>
          await this.processTemplatesForSpecific(
            runwayVideos,
            jobId,
            listingId,
            Object.keys(reelTemplates) as TemplateKey[],
            coordinates,
            mapVideo
          ),
        "Template processing"
      );

      if (templateResults.length === 0)
        throw new Error("No templates processed successfully");

      // In the execute method, update the job with processedTemplates information
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.COMPLETED,
          progress: 100,
          outputFile: templateResults[0],
          completedAt: new Date(),
          metadata: {
            defaultTemplate: input.template,
            processedTemplates: templateResults.map((path) => {
              // Check if this is a fallback (image) path
              const isFallback =
                path.includes("/images/processed/") &&
                (path.endsWith(".webp") ||
                  path.endsWith(".jpg") ||
                  path.endsWith(".png"));

              return {
                key: input.template,
                path,
                usedFallback: isFallback,
              };
            }),
            isRegeneration,
            regenerationContext: regenerationContext
              ? JSON.parse(JSON.stringify(regenerationContext))
              : null,
            skipRunwayIfCached: input.skipRunwayIfCached,
            skipLock: input.skipLock,
            runwayVideosCount: runwayVideos.length,
            hasMapVideo: !!mapVideo,
          } satisfies Prisma.InputJsonValue,
        },
      });

      return templateResults[0];
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`[${jobId}] Pipeline execution failed`, {
        error: errorMessage,
        stack: errorStack,
        input,
        timestamp: new Date().toISOString(),
      });

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.FAILED,
          error: errorMessage,
          metadata: {
            errorDetails: {
              message: errorMessage,
              stack: errorStack,
              timestamp: new Date().toISOString(),
            },
            isRegeneration,
            forceRegeneration,
            regenerationContext: regenerationContext
              ? JSON.parse(JSON.stringify(regenerationContext))
              : null,
            skipRunwayIfCached: input.skipRunwayIfCached,
            skipLock: input.skipLock,
          } satisfies Prisma.InputJsonValue,
        },
      });
      throw error;
    } finally {
      logger.info(`[${jobId}] Starting cleanup sequence`);
      let lockReleased = false;

      if (!input.skipLock && input.listingId) {
        for (let attempt = 1; attempt <= 3 && !lockReleased; attempt++) {
          try {
            await this.releaseListingLock(jobId, input.listingId);
            lockReleased = true;
            logger.info(
              `[${jobId}] Lock released for listing ${input.listingId}`
            );
          } catch (lockError) {
            logger.error(
              `[${jobId}] Failed to release lock (Attempt ${attempt}/3)`,
              {
                error:
                  lockError instanceof Error
                    ? lockError.message
                    : "Unknown error",
              }
            );
            if (attempt < 3)
              await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }

      try {
        await this.resourceManager.cleanup();
        logger.info(`[${jobId}] Cleanup completed`);
      } catch (cleanupError) {
        logger.error(`[${jobId}] Cleanup failed`, {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : "Unknown error",
        });
      }
    }
  }

  private checkMemoryUsage(jobId: string): void {
    const now = Date.now();
    const used = process.memoryUsage();
    const heapUsed = used.heapUsed / 1024 / 1024; // Convert to MB
    const heapTotal = used.heapTotal / 1024 / 1024; // Convert to MB
    const heapUsage = used.heapUsed / used.heapTotal;

    logger.info(`[${jobId}] Resource usage before FFmpeg task`, {
      heapUsed: `${heapUsed.toFixed(2)} MB`,
      heapTotal: `${heapTotal.toFixed(2)} MB`,
      heapUsage: `${(heapUsage * 100).toFixed(1)}%`,
      activeFFmpegJobs: ffmpegQueueManager.getActiveCount(),
    });

    const memoryInfo = {
      heapUsed: `${heapUsed.toFixed(2)} MB`,
      heapTotal: `${heapTotal.toFixed(2)} MB`,
      usage: `${(heapUsage * 100).toFixed(1)}%`,
      rss: `${(used.rss / 1024 / 1024).toFixed(2)} MB`,
      previousBatchSize: this.currentBatchSize,
    };

    if (heapTotal <= 1000) return;

    let newBatchSize = this.currentBatchSize;
    let action = null;

    if (heapUsage > this.MEMORY_CRITICAL_THRESHOLD && heapTotal > 1000) {
      newBatchSize = Math.max(
        this.MIN_BATCH_SIZE,
        Math.floor(this.currentBatchSize * 0.5)
      );
      action = "REDUCE_BATCH_SIZE_CRITICAL_IMMEDIATE";

      this.lastBatchSizeAdjustment = now;
      this.currentBatchSize = newBatchSize;
      this.limit = pLimit(this.currentBatchSize);

      logger.warn(
        `[${jobId}] Immediate batch size reduction due to critical memory`,
        {
          ...memoryInfo,
          newBatchSize,
          memoryUsage: {
            current: `${(heapUsage * 100).toFixed(1)}%`,
            critical: `${(this.MEMORY_CRITICAL_THRESHOLD * 100).toFixed(1)}%`,
          },
        }
      );
      return; // Exit after immediate adjustment
    }

    if (
      now - this.lastBatchSizeAdjustment <
      this.BATCH_SIZE_ADJUSTMENT_INTERVAL
    )
      return;

    if (heapUsage > this.MEMORY_CRITICAL_THRESHOLD) {
      newBatchSize = Math.max(
        this.MIN_BATCH_SIZE,
        Math.floor(this.currentBatchSize * 0.5)
      );
      action = "REDUCE_BATCH_SIZE_CRITICAL";
    } else if (heapUsage > this.MEMORY_WARNING_THRESHOLD) {
      newBatchSize = Math.max(
        this.MIN_BATCH_SIZE,
        Math.floor(this.currentBatchSize * 0.75)
      );
      action = "REDUCE_BATCH_SIZE_WARNING";
    } else if (
      heapUsage < this.MEMORY_RESET_THRESHOLD &&
      this.currentBatchSize < this.DEFAULT_BATCH_SIZE
    ) {
      newBatchSize = this.DEFAULT_BATCH_SIZE;
      action = "RESET_BATCH_SIZE";
    } else if (
      heapUsage < this.MEMORY_STABLE_THRESHOLD &&
      this.currentBatchSize < this.DEFAULT_BATCH_SIZE
    ) {
      newBatchSize = Math.min(
        this.DEFAULT_BATCH_SIZE,
        this.currentBatchSize +
          Math.max(1, Math.floor(this.currentBatchSize * 0.2))
      );
      action = "INCREASE_BATCH_SIZE";
    }

    if (newBatchSize !== this.currentBatchSize) {
      this.lastBatchSizeAdjustment = now;
      this.currentBatchSize = newBatchSize;
      this.limit = pLimit(this.currentBatchSize);

      const logLevel = action?.startsWith("REDUCE") ? "warn" : "info";
      logger[logLevel](`[${jobId}] Adjusting batch size`, {
        ...memoryInfo,
        newBatchSize: this.currentBatchSize,
        action,
        memoryUsage: {
          current: `${(heapUsage * 100).toFixed(1)}%`,
          warning: `${(this.MEMORY_WARNING_THRESHOLD * 100).toFixed(1)}%`,
          critical: `${(this.MEMORY_CRITICAL_THRESHOLD * 100).toFixed(1)}%`,
          stable: `${(this.MEMORY_STABLE_THRESHOLD * 100).toFixed(1)}%`,
          reset: `${(this.MEMORY_RESET_THRESHOLD * 100).toFixed(1)}%`,
        },
      });
    }
  }

  private async processWithMemoryCheck<T>(
    jobId: string,
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    this.checkMemoryUsage(jobId);

    try {
      const result = await operation();
      this.checkMemoryUsage(jobId); // Check after operation too
      return result;
    } catch (error) {
      logger.error(`[${jobId}] Error during ${context}`, {
        error: error instanceof Error ? error.message : "Unknown error",
        currentBatchSize: this.currentBatchSize,
      });
      throw error;
    }
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    retries: number,
    context: string,
    jobId: string
  ): Promise<T> {
    let lastError: unknown;
    const isS3Operation =
      context.toLowerCase().includes("video") ||
      context.toLowerCase().includes("s3") ||
      context.toLowerCase().includes("upload");

    // Use longer initial delay for S3 operations (2s vs 1s)
    const initialDelay = isS3Operation ? 2000 : 1000;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt > retries) {
          logger.error(
            `[${jobId}] ${context} failed after ${retries} retries`,
            {
              error: error instanceof Error ? error.message : "Unknown error",
              stack: error instanceof Error ? error.stack : undefined,
            }
          );
          throw new Error(
            `${context} failed after ${retries} retries: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }

        // Enhanced exponential backoff with longer delays for S3 operations
        const delay =
          initialDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random());

        logger.warn(
          `[${jobId}] ${context} failed, retrying in ${Math.round(delay)}ms`,
          {
            attempt,
            error: error instanceof Error ? error.message : "Unknown error",
            isS3Operation,
            initialDelay,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // This should never be reached due to the throw in the loop,
    // but TypeScript requires a return statement
    throw new Error(
      `${context} failed after ${retries} retries: ${
        lastError instanceof Error ? lastError.message : "Unknown error"
      }`
    );
  }

  private async generateMapVideoForTemplate(
    coordinates: { lat: number; lng: number },
    jobId: string,
    listingId: string
  ): Promise<string | null> {
    // Increase timeout to 5 minutes for map generation
    const MAP_GENERATION_TIMEOUT = 300000; // 5 minutes
    const MAX_RETRIES = 3;

    // Standardize cache key to use only listing ID and coordinates
    // This ensures consistency across regenerations
    const cacheKey = this.generateStandardMapCacheKey(listingId, coordinates);
    const tempS3Key = `temp/maps/${jobId}/${Date.now()}.mp4`;

    try {
      // Check cache first with validation
      const cachedPath = await this.getCachedAsset(cacheKey, "map");
      if (cachedPath) {
        const isValid = await this.validateMapVideo(cachedPath, jobId);
        if (isValid) {
          logger.info(`[${jobId}] Using validated cached map video from S3`, {
            cacheKey,
            cachedPath,
            listingId,
            coordinates,
          });
          return this.validateS3Url(cachedPath);
        } else {
          logger.warn(
            `[${jobId}] Cached map video failed validation, regenerating`,
            {
              cacheKey,
              cachedPath,
              listingId,
              coordinates,
            }
          );
        }
      }

      logger.info(`[${jobId}] Starting map video generation`, {
        coordinates,
        cacheKey,
        listingId,
      });

      // Generate map video with retries and validation
      let localVideoPath: string | null = null;
      let attempt = 0;

      while (attempt < MAX_RETRIES && !localVideoPath) {
        attempt++;
        try {
          localVideoPath = await Promise.race([
            mapCaptureService.generateMapVideo(coordinates, jobId),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Map video generation timeout")),
                MAP_GENERATION_TIMEOUT
              )
            ),
          ]);

          // Validate the generated video
          if (localVideoPath) {
            const isValid = await this.validateMapVideo(localVideoPath, jobId);
            if (!isValid) {
              logger.warn(
                `[${jobId}] Generated map video failed validation, retrying`,
                {
                  attempt,
                  path: localVideoPath,
                  listingId,
                  coordinates,
                }
              );
              localVideoPath = null;
              continue;
            }
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger.warn(`[${jobId}] Map generation attempt ${attempt} failed`, {
            error: errorMessage,
            coordinates,
            listingId,
          });

          if (attempt < MAX_RETRIES) {
            const delay = Math.min(
              1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random()),
              30000
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!localVideoPath) {
        throw new Error(
          `Failed to generate valid map video after ${MAX_RETRIES} attempts`
        );
      }

      // Upload to temp location with validation
      const fileBuffer = await fs.readFile(localVideoPath);
      await this.s3VideoService.uploadFile(fileBuffer, tempS3Key);

      // Move to final location
      const finalS3Url = await this.s3VideoService.moveFromTempToListing(
        tempS3Key,
        listingId,
        jobId
      );

      // Final validation after move
      const finalValidation = await this.validateMapVideo(finalS3Url, jobId);
      if (!finalValidation) {
        throw new Error("Final map video failed validation after S3 move");
      }

      // Add a retry loop to verify S3 accessibility due to S3 eventual consistency
      const verifyS3Availability = async (
        url: string,
        retries = 3
      ): Promise<boolean> => {
        for (let i = 0; i < retries; i++) {
          const s3Key = this.getS3KeyFromUrl(url);
          if (await this.verifyS3Asset(s3Key)) return true;
          logger.warn(
            `[${jobId}] S3 file not yet accessible, retrying (attempt ${
              i + 1
            }/${retries})`,
            {
              url,
              s3Key,
            }
          );
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, i))
          );
        }
        return false;
      };

      if (!(await verifyS3Availability(finalS3Url))) {
        throw new Error("Uploaded map video not accessible after retries");
      }

      // Cache the validated video with the standardized cache key
      await this.cacheAsset(jobId, cacheKey, finalS3Url, "map");

      logger.info(`[${jobId}] Map video generation completed and validated`, {
        finalS3Url,
        cacheKey,
        listingId,
        coordinates,
      });

      return finalS3Url;
    } catch (error) {
      logger.error(`[${jobId}] Map video generation failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
        listingId,
        cacheKey,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  // Helper method to generate a standardized cache key for map videos
  private generateStandardMapCacheKey(
    listingId: string,
    coordinates: { lat: number; lng: number }
  ): string {
    // Round coordinates to 6 decimal places for consistent cache keys
    const lat = Math.round(coordinates.lat * 1000000) / 1000000;
    const lng = Math.round(coordinates.lng * 1000000) / 1000000;
    return `map_${listingId}_${lat}_${lng}`;
  }

  private async validateMapVideo(
    videoPath: string,
    jobId: string
  ): Promise<boolean> {
    try {
      let localPath = videoPath;

      if (videoPath.startsWith("https://") || videoPath.startsWith("s3://")) {
        localPath = path.join(
          process.cwd(),
          "temp",
          `${jobId}_map_validate_${crypto.randomUUID()}.mp4`
        );
        await this.s3Service.downloadFile(videoPath, localPath);
        await this.resourceManager.trackResource(localPath);

        logger.debug(`[${jobId}] Downloaded map video for validation`, {
          s3Path: videoPath,
          localPath,
        });
      }

      // Check if file exists and is readable
      await fs.access(localPath, fs.constants.R_OK);

      // Check file size
      const stats = await fs.stat(localPath);
      if (stats.size < 1024) {
        logger.warn(`[${jobId}] Map video file too small`, {
          size: stats.size,
          path: videoPath,
        });
        return false;
      }

      // Check duration
      const duration = await videoProcessingService.getVideoDuration(localPath);
      if (duration < 1) {
        logger.warn(`[${jobId}] Map video duration too short`, {
          duration,
          path: videoPath,
        });
        return false;
      }

      // Check integrity
      const isIntegrityValid =
        await videoProcessingService.validateVideoIntegrity(localPath);
      if (!isIntegrityValid) {
        logger.warn(`[${jobId}] Map video integrity check failed`, {
          path: videoPath,
        });
        return false;
      }

      // Get and check metadata
      const metadata = await videoProcessingService.getVideoMetadata(localPath);

      // Log full metadata for debugging
      logger.debug(`[${jobId}] Map video metadata`, {
        path: videoPath,
        metadata,
      });

      // Check for video stream
      if (!metadata.hasVideo || !metadata.width || !metadata.height) {
        logger.warn(`[${jobId}] Map video missing required metadata`, {
          path: videoPath,
          metadata,
        });

        // Fallback: Use FFprobe directly to verify video content
        const ffprobeOutput = await this.runFFprobe(localPath);
        if (
          !ffprobeOutput.streams ||
          !ffprobeOutput.streams.some(
            (stream: FfprobeStream) => stream.codec_type === "video"
          )
        ) {
          logger.error(`[${jobId}] FFprobe confirms no video content`, {
            path: videoPath,
            ffprobeOutput,
          });
          return false;
        }

        // If FFprobe found a video stream, we'll continue despite the initial check failing
        logger.info(
          `[${jobId}] FFprobe found video stream despite metadata check failure`,
          {
            path: videoPath,
          }
        );
      }

      // Clean up downloaded file if needed
      if (
        (videoPath.startsWith("https://") || videoPath.startsWith("s3://")) &&
        localPath !== videoPath
      ) {
        await fs.unlink(localPath).catch((error) => {
          logger.warn(
            `[${jobId}] Failed to cleanup temporary validation file`,
            {
              path: localPath,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
        });
      }

      logger.info(`[${jobId}] Map video validation successful`, {
        path: videoPath,
        duration,
        size: stats.size,
        metadata: {
          hasVideo: metadata.hasVideo,
          width: metadata.width,
          height: metadata.height,
          codec: metadata.codec,
        },
      });

      return true;
    } catch (error) {
      logger.error(`[${jobId}] Map video validation failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
        path: videoPath,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }
  }

  // Helper method to run FFprobe
  private async runFFprobe(filePath: string): Promise<FfprobeData> {
    // Use shorter timeout for FFprobe which is typically quick
    const timeout = 30000; // 30 seconds for FFprobe
    const maxRetries = 2; // 2 retries for FFprobe

    try {
      return await ffmpegQueueManager.enqueueJob(
        () => {
          return new Promise<FfprobeData>((resolve, reject) => {
            ffmpeg.ffprobe(
              filePath,
              (err: Error | null, metadata: FfprobeData) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(metadata);
                }
              }
            );
          });
        },
        timeout,
        maxRetries
      );
    } catch (error) {
      logger.error(`FFprobe failed for file: ${filePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Return a minimal valid structure to avoid null reference errors
      return {
        streams: [],
        format: {
          duration: 0,
          size: 0,
          bit_rate: 0,
        },
        chapters: [],
      };
    }
  }

  /**
   * Waits for an S3 object to become available with exponential backoff
   * @param s3Key The S3 key to check
   * @param jobId Optional job ID for logging
   * @param maxRetries Maximum number of retries
   * @returns True if the object is available, false otherwise
   */
  private async waitForS3ObjectAvailability(
    s3Key: string,
    jobId?: string,
    maxRetries = 5
  ): Promise<boolean> {
    // First check if this is a local file path
    if (s3Key.startsWith("/") && !s3Key.startsWith("//")) {
      try {
        // Check if the file exists locally
        const exists = existsSync(s3Key);
        if (exists) {
          if (jobId) {
            logger.info(`[${jobId}] Local file verified available`, {
              path: s3Key,
            });
          }
          return true;
        } else {
          if (jobId) {
            logger.warn(`[${jobId}] Local file not accessible`, {
              path: s3Key,
            });
          }
          return false;
        }
      } catch (error) {
        if (jobId) {
          logger.warn(`[${jobId}] Error checking local file accessibility`, {
            path: s3Key,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
        return false;
      }
    }

    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const startTime = Date.now();

    for (let i = 0; i < maxRetries; i++) {
      try {
        const exists = await this.s3VideoService.checkFileExists(bucket, s3Key);
        if (exists) {
          if (jobId) {
            logger.info(`[${jobId}] S3 object verified available`, {
              s3Key,
              attempt: i + 1,
              elapsedMs: Date.now() - startTime,
            });
          }
          return true;
        }
      } catch (error) {
        // Ignore error and continue retrying
        if (jobId) {
          logger.warn(`[${jobId}] Error checking S3 object availability`, {
            s3Key,
            attempt: i + 1,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const delay = 2000 * Math.pow(2, i);
      if (jobId) {
        logger.info(
          `[${jobId}] S3 object not yet available, waiting ${delay}ms before retry`,
          {
            s3Key,
            attempt: i + 1,
            nextDelay: delay,
          }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (jobId) {
      logger.error(
        `[${jobId}] S3 object unavailable after ${maxRetries} retries`,
        {
          s3Key,
          totalTimeMs: Date.now() - startTime,
        }
      );
    }
    return false;
  }

  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".webp": "image/webp",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
    };
    return contentTypes[ext] || "application/octet-stream";
  }

  private async verifyResources(
    videos: string[],
    mapVideo: string | undefined | null
  ): Promise<void> {
    const verifyS3Url = async (url: string, context: string): Promise<void> => {
      if (url.startsWith("https://")) {
        // Extract bucket and key from S3 URL
        const urlParts = new URL(url);
        const bucket = urlParts.hostname.split(".")[0];
        const key = urlParts.pathname.slice(1); // Remove leading slash

        const exists = await this.s3VideoService.checkFileExists(bucket, key);
        if (!exists) {
          throw new Error(`S3 resource not accessible: ${context} - ${url}`);
        }

        logger.debug(`Verified S3 resource accessibility`, {
          context,
          url,
          bucket,
          key,
        });
      } else {
        // Verify local file
        try {
          await fs.access(url, fs.constants.R_OK);
          logger.debug(`Verified local file accessibility`, {
            context,
            path: url,
          });
        } catch (error) {
          throw new Error(`Local file not accessible: ${context} - ${url}`);
        }
      }
    };

    const verificationPromises = videos.map((path, index) =>
      verifyS3Url(path, `video_${index}`)
    );

    if (mapVideo) {
      verificationPromises.push(verifyS3Url(mapVideo, "map_video"));
    }

    // Verify watermark is accessible using the same S3 verification logic
    verificationPromises.push(
      this.assetManager
        .getAssetPath(AssetType.WATERMARK, "reelty_watermark.png")
        .then(async (path) => {
          await verifyS3Url(path, "watermark");
        })
        .catch((error) => {
          logger.error("Failed to verify watermark accessibility", error);
          throw new Error("Watermark file not accessible");
        })
    );

    await Promise.all(verificationPromises);
  }

  private validateVideoCount(
    validVideos: string[],
    totalExpected: number,
    jobId: string,
    isRegeneration: boolean,
    priorJobVideos: string[] = [],
    processedImages: string[] = []
  ): string[] {
    logger.info(`[${jobId}] Validating video count`, {
      valid: validVideos.length,
      total: totalExpected,
      isRegeneration,
      priorVideos: priorJobVideos.length,
    });

    // If we have valid videos, use them (but still log warnings)
    if (validVideos.length > 0) {
      // For both regeneration and normal processing, ensure we have enough videos
      if (validVideos.length < totalExpected) {
        logger.warn(`[${jobId}] Fewer videos than expected`, {
          valid: validVideos.length,
          expected: totalExpected,
          isRegeneration,
        });
      }
      return validVideos;
    }

    // No valid videos - try fallbacks
    if (priorJobVideos.length > 0) {
      logger.warn(`[${jobId}] Using prior job videos as fallback`, {
        count: priorJobVideos.length,
        expected: totalExpected,
      });
      return priorJobVideos.slice(0, totalExpected);
    }

    if (processedImages.length > 0) {
      logger.warn(`[${jobId}] Using processed images as fallback`, {
        count: processedImages.length,
        expected: totalExpected,
      });
      return processedImages.slice(0, totalExpected);
    }

    // If we get here, we have no valid content at all
    throw new Error(
      `No valid videos or fallback content available. Required: ${totalExpected}`
    );
  }

  // Helper for normal processing
  private async handleNormalProcessing(
    inputFiles: string[],
    jobId: string,
    listingId: string,
    existingPhotos: Array<{
      id: string;
      processedFilePath: string | null;
      status: string;
      filePath: string;
      order: number;
      runwayVideoPath: string | null;
    }>,
    verifiedVideos: Map<number, string>
  ): Promise<string[]> {
    logger.info(`[${jobId}] Starting normal processing flow`, {
      inputFilesCount: inputFiles.length,
      existingPhotosCount: existingPhotos.length,
      verifiedVideosCount: verifiedVideos.size,
    });

    // Initialize array to hold runway videos with the same length as inputFiles
    const runwayVideos = new Array(inputFiles.length).fill(null);

    // Fill with existing verified videos first
    for (const [order, videoPath] of verifiedVideos.entries()) {
      if (order < inputFiles.length) {
        runwayVideos[order] = videoPath;
        logger.debug(
          `[${jobId}] Using existing verified video for order ${order}`
        );
      }
    }

    // Process missing videos
    const processingPromises = inputFiles.map(async (input, index) => {
      // Skip if we already have a verified video for this position
      if (runwayVideos[index]) {
        return runwayVideos[index];
      }

      try {
        logger.info(`[${jobId}] Generating runway video for input ${index}`, {
          inputPath: input,
        });

        const result = await this.retryRunwayGeneration(
          input,
          index,
          listingId,
          jobId
        );

        if (!result?.s3Url) {
          logger.error(
            `[${jobId}] Failed to generate runway video for input ${index}`
          );
          return null;
        }

        // Find existing photo or create new one
        const existingPhoto = existingPhotos.find(
          (p: { order: number }) => p.order === index
        );

        if (existingPhoto) {
          // Update existing photo
          await this.prisma.photo.update({
            where: { id: existingPhoto.id },
            data: {
              runwayVideoPath: result.s3Url,
              status: "COMPLETED",
              updatedAt: new Date(),
            },
          });
        } else {
          // Create new photo record
          const job = await this.prisma.videoJob.findUnique({
            where: { id: jobId },
            select: { userId: true },
          });

          if (!job?.userId) {
            throw new Error(`Job ${jobId} not found or missing userId`);
          }

          await this.prisma.photo.upsert({
            where: {
              listingId_order: {
                listingId,
                order: index,
              },
            },
            update: {
              runwayVideoPath: result.s3Url,
              status: "COMPLETED",
              updatedAt: new Date(),
            },
            create: {
              listingId,
              order: index,
              filePath: input,
              runwayVideoPath: result.s3Url,
              status: "COMPLETED",
              userId: job.userId,
              s3Key: input.startsWith("http")
                ? input.split("/").pop() || ""
                : input,
            },
          });
        }

        return result.s3Url;
      } catch (error) {
        logger.error(`[${jobId}] Error processing input ${index}`, {
          error: error instanceof Error ? error.message : "Unknown error",
          inputPath: input,
        });
        return null;
      }
    });

    // Wait for all processing to complete
    const results = await Promise.all(processingPromises);

    // Filter out null values and return valid runway video paths
    const validResults = results.filter(
      (result): result is string => result !== null
    );

    logger.info(`[${jobId}] Normal processing complete`, {
      totalInputs: inputFiles.length,
      validResults: validResults.length,
    });

    return validResults;
  }

  private async getRunwayVideos(jobId: string): Promise<
    Array<{
      order: number;
      path: string;
      id?: string;
    }>
  > {
    logger.info(`[${jobId}] Retrieving existing runway videos`);

    // Get the listing ID from the job
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { listingId: true },
    });

    if (!job?.listingId) {
      logger.warn(`[${jobId}] Job not found or missing listingId`);
      return [];
    }

    // Get all photos with runway videos for this listing
    const photos = await this.prisma.photo.findMany({
      where: {
        listingId: job.listingId,
        runwayVideoPath: { not: null },
      },
      select: {
        id: true,
        order: true,
        runwayVideoPath: true,
      },
      orderBy: { order: "asc" },
    });

    logger.info(`[${jobId}] Found ${photos.length} existing runway videos`);

    // Map to the expected return format
    return photos.map((photo) => ({
      id: photo.id,
      order: photo.order,
      path: photo.runwayVideoPath as string, // We filtered for non-null above
    }));
  }

  public static async reprocessUserVideos(userId: string): Promise<void> {
    const prisma = new PrismaClient();

    try {
      // Get all completed video jobs for the user
      const videoJobs = await prisma.videoJob.findMany({
        where: {
          userId,
          status: VideoGenerationStatus.COMPLETED,
        },
        include: {
          listing: {
            include: {
              photos: {
                where: {
                  runwayVideoPath: { not: null },
                },
                orderBy: { order: "asc" },
                select: {
                  id: true,
                  order: true,
                  runwayVideoPath: true,
                  processedFilePath: true,
                },
              },
            },
          },
        },
      });

      logger.info(`Reprocessing videos for user ${userId}`, {
        jobCount: videoJobs.length,
      });

      // Create new pipeline instance for processing
      const pipeline = new ProductionPipeline(prisma);

      // Process each job
      for (const job of videoJobs) {
        try {
          // Get the existing runway videos in order
          const runwayVideos = job.listing.photos
            .filter((p) => p.runwayVideoPath)
            .sort((a, b) => a.order - b.order)
            .map((p) => p.runwayVideoPath!);

          if (runwayVideos.length === 0) {
            logger.warn(`No runway videos found for job ${job.id}`);
            continue;
          }

          // Extract coordinates from listing instead of job metadata
          const coordinates = job.listing.coordinates as
            | { lat: number; lng: number }
            | undefined;

          // Create a new job for reprocessing
          const newJob = await prisma.videoJob.create({
            data: {
              userId,
              listingId: job.listingId,
              template: job.template || "crescendo", // fallback to default if none specified
              status: VideoGenerationStatus.PENDING,
              metadata: {
                isRegeneration: true,
                originalJobId: job.id,
                coordinates,
              },
            },
          });

          // Process the templates with existing runway videos
          await pipeline.execute({
            jobId: newJob.id,
            listingId: job.listingId,
            inputFiles: [], // Empty because we're using existing runway videos
            template: (job.template as TemplateKey) || "crescendo",
            coordinates,
            isRegeneration: true,
            skipRunway: true, // Skip runway since we're using existing videos
            regenerationContext: {
              photosToRegenerate: [],
              existingPhotos: job.listing.photos
                .filter((p) => p.processedFilePath && p.id && p.order !== null)
                .map((p) => ({
                  id: p.id,
                  processedFilePath: p.processedFilePath!,
                  order: p.order,
                  runwayVideoPath: p.runwayVideoPath || undefined,
                })),
              regeneratedPhotoIds: [],
              totalPhotos: job.listing.photos.length,
            },
          });

          logger.info(
            `Successfully reprocessed job ${job.id} for user ${userId}`
          );
        } catch (error) {
          logger.error(`Failed to reprocess job ${job.id}`, {
            error: error instanceof Error ? error.message : "Unknown error",
            userId,
            jobId: job.id,
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to reprocess videos for user ${userId}`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      await prisma.$disconnect();
    }
  }

  private async isRegeneration(jobId: string): Promise<boolean> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { metadata: true },
    });
    return (job?.metadata as any)?.isRegeneration === true;
  }
}
