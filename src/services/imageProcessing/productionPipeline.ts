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
import { v4 as uuidv4 } from "uuid";
import ffmpeg, { FfprobeData, FfprobeStream } from "fluent-ffmpeg";

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
  forceRegeneration?: boolean; // Added this field
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
  private readonly MEMORY_WARNING_THRESHOLD = 0.7; // 70% memory usage triggers warning
  private readonly MEMORY_CRITICAL_THRESHOLD = 0.8; // 80% memory usage triggers reduction
  private readonly MEMORY_STABLE_THRESHOLD = 0.4; // 40% memory usage considered stable
  private readonly MEMORY_RESET_THRESHOLD = 0.3; // 30% memory usage triggers reset
  private readonly BATCH_SIZE_ADJUSTMENT_INTERVAL = 5000; // 5 seconds between adjustments
  private lastBatchSizeAdjustment: number = 0;
  private readonly MAX_RETRIES = 3;
  private readonly DEFAULT_BATCH_SIZE = 5;
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
    this.currentBatchSize = this.DEFAULT_BATCH_SIZE;
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

  private async withRetry<T>(
    operation: () => Promise<T>,
    retries = this.MAX_RETRIES
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === retries) throw error;
        const delay = attempt * 1000;
        logger.warn(`Retry attempt ${attempt}/${retries}, waiting ${delay}ms`, {
          error,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Retry failed");
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
    try {
      const s3Key = this.getS3KeyFromUrl(s3Url);
      const exists = await this.verifyS3Asset(s3Key);

      if (!exists) {
        return {
          success: false,
          error: `Generated video not accessible at ${s3Url}`,
        };
      }

      const tempPath = path.join(
        process.cwd(),
        "temp",
        `${jobId}_validate_${index}.mp4`
      );

      await this.resourceManager.trackResource(tempPath);

      try {
        await this.s3Service.downloadFile(s3Url, tempPath);
        const duration = await videoProcessingService.getVideoDuration(
          tempPath
        );

        if (duration <= 0) {
          return {
            success: false,
            error: `Invalid video duration (${duration}s) from Runway output`,
          };
        }

        const isValid = await videoProcessingService.validateVideoIntegrity(
          tempPath
        );
        if (!isValid) {
          return {
            success: false,
            error: "Video file integrity check failed",
          };
        }

        return { success: true, duration };
      } finally {
        await fs.unlink(tempPath).catch((error) => {
          logger.warn(`[${jobId}] Failed to cleanup validation file`, {
            path: tempPath,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        });
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async validateWithCache(
    s3Url: string,
    index: number,
    jobId: string
  ): Promise<ValidationCache | null> {
    const cacheKey = `${jobId}_${index}`;
    const cached = this.validationCache.get(cacheKey);

    if (
      cached &&
      Date.now() - cached.validatedAt.getTime() < this.VALIDATION_CACHE_TTL
    ) {
      logger.debug(`[${jobId}] Using cached validation for video`, {
        s3Url,
        index,
        cachedAt: cached.validatedAt,
      });
      return cached;
    }

    const validation = await this.validateRunwayVideo(s3Url, index, jobId);
    if (!validation.success) {
      return null;
    }

    const cacheEntry: ValidationCache = {
      s3Url,
      duration: validation.duration!,
      validatedAt: new Date(),
    };

    this.validationCache.set(cacheKey, cacheEntry);
    return cacheEntry;
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
      const result = await this.retryRunwayGeneration(
        inputUrl,
        index,
        job.listingId,
        jobId
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
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  private getS3KeyFromUrl(url: string): string {
    if (url.startsWith("s3://")) {
      const parts = url.slice(5).split("/");
      return parts.slice(1).join("/"); // Remove bucket name
    }
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/");
      // Skip the first empty part due to leading slash
      return pathParts.slice(1).join("/");
    } catch (error) {
      // If not a valid URL, assume it's a key
      return url;
    }
  }

  private validateS3Url(url: string): string {
    if (url.startsWith("https://") || url.startsWith("s3://")) {
      return url;
    }
    // If it's just a key, convert it to a full URL
    return this.getS3UrlFromKey(url);
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
    const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
    const s3Key = this.getS3KeyFromUrl(path);
    const MAX_TIMEOUT = 30000; // 30 seconds total timeout
    const startTime = Date.now();

    logger.debug(`[${jobId}] Verifying S3 video access`, {
      originalPath: path,
      extractedKey: s3Key,
      bucket: bucketName,
    });

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
        const exists = await this.s3VideoService.checkFileExists(
          bucketName,
          s3Key
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
          // Exponential backoff with jitter
          const delay = Math.min(
            1000 * Math.pow(2, attempt) * (0.5 + Math.random()),
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
            1000 * Math.pow(2, attempt) * (0.5 + Math.random()),
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
    return null;
  }

  private async getSharedWatermarkPath(
    jobId: string
  ): Promise<string | undefined> {
    const sharedPath = path.join(
      process.cwd(),
      "temp",
      `${jobId}_watermark.png`
    );

    try {
      // Check if watermark already exists
      if (!existsSync(sharedPath)) {
        const watermarkAssetPath = await this.assetManager.getAssetPath(
          AssetType.WATERMARK,
          // "reelty_watermark.png"
          "watermark_transparent_v1.png"
        );

        await this.s3Service.downloadFile(watermarkAssetPath, sharedPath);
        await this.resourceManager.trackResource(sharedPath);

        logger.info(`[${jobId}] Downloaded shared watermark`, {
          path: sharedPath,
          source: watermarkAssetPath,
        });
      } else {
        logger.debug(`[${jobId}] Using existing shared watermark`, {
          path: sharedPath,
        });
      }

      return sharedPath;
    } catch (error) {
      logger.warn(`[${jobId}] Failed to download shared watermark`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      return undefined;
    }
  }

  private async withResourceTracking<T>(
    jobId: string,
    operation: () => Promise<T>,
    resources: ResourceTracker[]
  ): Promise<T> {
    for (const resource of resources) {
      await this.resourceManager.trackResource(resource.path);
      logger.debug(`[${jobId}] Tracking resource`, {
        path: resource.path,
        type: resource.type,
        metadata: resource.metadata,
      });
    }
    return operation();
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
    const videoTemplateService = VideoTemplateService.getInstance();

    try {
      await fs.mkdir(tempDir, { recursive: true });
      const templateConfig = reelTemplates[template];

      // Validate durations early
      const durations = Array.isArray(templateConfig.durations)
        ? templateConfig.durations
        : Object.values(templateConfig.durations);

      if (!durations.length) {
        throw new Error(`Template ${template} has no valid durations defined`);
      }

      if (durations.some((d) => typeof d !== "number" || d <= 0)) {
        throw new Error(`Template ${template} has invalid duration values`);
      }

      // Check map requirement
      const needsMap = templateConfig.sequence.includes("map");
      if (needsMap && !mapVideo) {
        const error = `Map video required but not available for template ${template}`;
        logger.error(`[${jobId}] ${error}`);
        return { template, status: "FAILED", outputPath: null, error };
      }

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: template,
        progress: 0,
        message: `Generating ${template} template`,
      });

      // Pre-register all resources for tracking
      const watermarkConfig = await this.getSharedWatermarkPath(jobId);
      const resources: ResourceTracker[] = [
        ...runwayVideos.map((_, index) => ({
          path: path.join(tempDir, `segment_${index}.mp4`),
          type: "video" as const,
        })),
        ...(needsMap && mapVideo
          ? [{ path: path.join(tempDir, "map.mp4"), type: "video" as const }]
          : []),
        ...(templateConfig.music?.path
          ? [
              {
                path: path.join(tempDir, `music_${template}.mp3`),
                type: "music" as const,
              },
            ]
          : []),
        ...(watermarkConfig
          ? [{ path: watermarkConfig, type: "watermark" as const }]
          : []),
      ];

      return await this.withResourceTracking(
        jobId,
        async () => {
          // Download and validate runway videos
          const processedVideos = await Promise.all(
            runwayVideos.map(async (video, index) => {
              const localPath = path.join(tempDir, `segment_${index}.mp4`);
              const validation = await this.validateWithCache(
                video,
                index,
                jobId
              );

              if (!validation) {
                logger.warn(`[${jobId}] Skipping invalid video`, {
                  index,
                  path: video,
                });
                return null;
              }

              await this.s3Service.downloadFile(video, localPath);
              return {
                path: localPath,
                duration: validation.duration,
              } as ValidatedVideo;
            })
          );

          const validVideos = processedVideos.filter(
            (v): v is ValidatedVideo => v !== null
          );
          if (validVideos.length === 0) {
            throw new Error(
              "No valid videos available for template processing"
            );
          }

          // Process map video if needed
          let processedMapVideo: ValidatedVideo | undefined;
          if (needsMap && mapVideo) {
            const mapPath = path.join(tempDir, "map.mp4");
            const mapValidation = await this.validateWithCache(
              mapVideo,
              -1,
              jobId
            );

            if (mapValidation) {
              await this.s3Service.downloadFile(mapVideo, mapPath);
              processedMapVideo = {
                path: mapPath,
                duration: mapValidation.duration,
              };
            }
          }

          // Process music
          let processedMusic: ReelTemplate["music"] | undefined;
          if (templateConfig.music?.path) {
            const musicPath = path.join(tempDir, `music_${template}.mp3`);
            try {
              const resolvedMusicPath =
                await videoTemplateService.resolveAssetPath(
                  templateConfig.music.path,
                  "music",
                  true
                );

              if (resolvedMusicPath) {
                await this.s3Service.downloadFile(resolvedMusicPath, musicPath);
                const isValid = await videoProcessingService.validateMusicFile(
                  musicPath
                );
                if (isValid) {
                  processedMusic = {
                    ...templateConfig.music,
                    path: musicPath,
                    isValid: true,
                  };
                }
              }
            } catch (error) {
              logger.warn(`[${jobId}] Music file issue, proceeding without`, {
                path: templateConfig.music.path,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
          }

          // Prepare clips
          const clips = validVideos.map((video, index) => ({
            path: video.path,
            duration: durations[index] || video.duration,
            transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
            colorCorrection: templateConfig.colorCorrection,
          }));

          const outputPath = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/properties/${listingId}/videos/templates/${jobId}/${template}.mp4`;

          // Configure watermark
          const watermarkSettings = watermarkConfig
            ? ({
                path: watermarkConfig,
                position: {
                  x: "(main_w-overlay_w)/2",
                  y: "main_h-overlay_h-300",
                },
              } as WatermarkConfig)
            : undefined;

          // Stitch video and verify output
          await videoProcessingService.stitchVideos(
            clips,
            outputPath,
            {
              name: templateConfig.name,
              description: templateConfig.description,
              colorCorrection: templateConfig.colorCorrection,
              transitions: templateConfig.transitions,
              reverseClips: templateConfig.reverseClips,
              music: processedMusic,
              outputOptions: ["-q:a 2"],
            } as VideoTemplate,
            watermarkSettings
          );

          const verifiedUrl = await this.verifyS3VideoAccess(outputPath, jobId);
          if (!verifiedUrl) {
            throw new Error(`Uploaded video not accessible at ${outputPath}`);
          }

          await this.updateJobProgress(jobId, {
            stage: "template",
            subStage: template,
            progress: 100,
            message: `${template} template completed`,
          });

          return {
            template,
            status: "SUCCESS",
            outputPath: verifiedUrl,
            processingTime: Date.now() - startTime,
          };
        },
        resources
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`[${jobId}] Template processing error`, {
        template,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: template,
        progress: 0,
        error: errorMessage,
      });

      return {
        template,
        status: "FAILED",
        outputPath: null,
        error: errorMessage,
        processingTime: Date.now() - startTime,
      };
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
    const BATCH_SIZE = 2;
    const results: string[] = [];

    // Separate map-dependent templates from others
    const mapDependentTemplates = templates.filter(
      (t) => reelTemplates[t].sequence[0] === "map"
    );
    const regularTemplates = templates.filter(
      (t) => reelTemplates[t].sequence[0] !== "map"
    );

    // Validate map requirements early
    if (mapDependentTemplates.length > 0) {
      if (!coordinates) {
        logger.warn(
          `[${jobId}] Map-dependent templates requested but no coordinates provided`,
          {
            templates: mapDependentTemplates,
          }
        );
        // Filter out map-dependent templates if no coordinates
        templates = regularTemplates;
      } else if (!mapVideo) {
        // Try to generate map video if not provided
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

          if (!mapVideo) {
            throw new Error("Map video generation failed");
          }
        } catch (error) {
          logger.error(`[${jobId}] Failed to generate map video`, {
            error: error instanceof Error ? error.message : String(error),
            coordinates,
          });
          // Continue with regular templates only
          templates = regularTemplates;
        }
      }
    }

    // Process regular templates in batches
    for (let i = 0; i < regularTemplates.length; i += BATCH_SIZE) {
      const batch = regularTemplates.slice(i, i + BATCH_SIZE);

      try {
        logger.info(
          `[${jobId}] Processing regular template batch ${i / BATCH_SIZE + 1}`,
          {
            templates: batch,
            batchSize: batch.length,
          }
        );

        const batchResults = await Promise.all(
          batch.map((template) =>
            this.processTemplate(
              template,
              runwayVideos,
              jobId,
              listingId,
              coordinates,
              mapVideo
            )
          )
        );

        const successfulOutputs = batchResults
          .filter((result) => result.status === "SUCCESS" && result.outputPath)
          .map((result) => result.outputPath!);

        results.push(...successfulOutputs);

        // Log batch completion status
        logger.info(`[${jobId}] Batch ${i / BATCH_SIZE + 1} completed`, {
          total: batch.length,
          successful: successfulOutputs.length,
          failed: batch.length - successfulOutputs.length,
        });
      } catch (error) {
        logger.error(`[${jobId}] Batch processing failed`, {
          batch,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with next batch despite errors
        continue;
      }

      // Small delay between batches
      if (i + BATCH_SIZE < regularTemplates.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Process map-dependent templates if map video is available
    if (mapDependentTemplates.length > 0 && mapVideo) {
      logger.info(`[${jobId}] Processing map-dependent templates`, {
        templates: mapDependentTemplates,
        mapVideoPath: mapVideo,
      });

      // Validate map video before processing
      try {
        const isMapValid = await this.validateMapVideo(mapVideo, jobId);
        if (!isMapValid) {
          throw new Error("Map video validation failed");
        }

        // Process map-dependent templates one at a time
        for (const template of mapDependentTemplates) {
          try {
            logger.info(`[${jobId}] Processing map template: ${template}`, {
              mapVideo,
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
              logger.info(`[${jobId}] Map template processed successfully`, {
                template,
                processingTime: result.processingTime,
              });
            } else {
              throw new Error(
                result.error || "Unknown error in map template processing"
              );
            }
          } catch (error) {
            logger.error(`[${jobId}] Map template processing failed`, {
              template,
              error: error instanceof Error ? error.message : String(error),
            });
            // Continue with next template despite errors
            continue;
          }

          // Small delay between map templates
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        logger.error(`[${jobId}] Map video validation failed`, {
          mapVideo,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Validate results before returning
    if (results.length === 0) {
      logger.error(`[${jobId}] No templates processed successfully`, {
        regularTemplatesCount: regularTemplates.length,
        mapDependentTemplatesCount: mapDependentTemplates.length,
        hasMapVideo: !!mapVideo,
        hasCoordinates: !!coordinates,
      });
      throw new Error("No templates processed successfully");
    }

    logger.info(`[${jobId}] Template processing completed`, {
      successfulTemplatesCount: results.length,
      templates: results.map((path: string) => {
        const parts = path.split("/");
        return parts[parts.length - 1].split("_")[0]; // Extract template name from path
      }),
    });

    return results;
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
      let listingId = input.listingId;
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

      await this.processWithMemoryCheck(
        jobId,
        async () => await this.processVisionImages(jobId),
        "Vision image processing"
      );

      let runwayVideos: string[] = [];
      const options = {
        isRegeneration,
        forceRegeneration,
        regenerationContext,
      };

      if (!input.skipRunwayIfCached) {
        runwayVideos = await this.processWithMemoryCheck(
          jobId,
          async () =>
            await this.retryWithBackoff(
              () => this.processRunwayVideos(jobId, inputFiles, options),
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
                () => this.processRunwayVideos(jobId, inputFiles, options),
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

      const mapVideo = input.coordinates
        ? await this.processWithMemoryCheck(
            jobId,
            async () =>
              await this.generateMapVideoForTemplate(
                input.coordinates!,
                jobId,
                listingId
              ),
            "Map video generation"
          )
        : null;

      if (mapVideo) {
        await this.verifyResources([mapVideo], null);
      }

      const templateResults = await this.processWithMemoryCheck(
        jobId,
        async () =>
          await this.processTemplatesForSpecific(
            runwayVideos,
            jobId,
            listingId,
            Object.keys(reelTemplates) as TemplateKey[],
            input.coordinates,
            mapVideo
          ),
        "Template processing"
      );

      if (templateResults.length === 0)
        throw new Error("No templates processed successfully");

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.COMPLETED,
          progress: 100,
          outputFile: templateResults[0],
          completedAt: new Date(),
          metadata: {
            defaultTemplate: input.template,
            processedTemplates: templateResults.map((path) => ({
              key: input.template,
              path,
            })),
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

        const delay = 1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random());
        logger.warn(
          `[${jobId}] ${context} failed, retrying in ${Math.round(delay)}ms`,
          {
            attempt,
            error: error instanceof Error ? error.message : "Unknown error",
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

    const cacheKey = `map_${jobId}_${crypto
      .createHash("md5")
      .update(`${coordinates.lat},${coordinates.lng}`)
      .digest("hex")}`;
    const tempS3Key = `temp/maps/${jobId}/${Date.now()}.mp4`;

    try {
      // Check cache first with validation
      const cachedPath = await this.getCachedAsset(cacheKey, "map");
      if (cachedPath) {
        const isValid = await this.validateMapVideo(cachedPath, jobId);
        if (isValid) {
          logger.info(`[${jobId}] Using validated cached map video from S3`, {
            cachedPath,
          });
          return this.validateS3Url(cachedPath);
        } else {
          logger.warn(
            `[${jobId}] Cached map video failed validation, regenerating`,
            {
              cachedPath,
            }
          );
        }
      }

      logger.info(`[${jobId}] Starting map video generation`, {
        coordinates,
        cacheKey,
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

      // Cache the validated video
      await this.cacheAsset(jobId, cacheKey, finalS3Url, "map");

      logger.info(`[${jobId}] Map video generation completed and validated`, {
        finalS3Url,
      });

      return finalS3Url;
    } catch (error) {
      logger.error(`[${jobId}] Map video generation failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  private async validateMapVideo(
    videoPath: string,
    jobId: string
  ): Promise<boolean> {
    try {
      let localPath = videoPath;

      if (videoPath.startsWith("https://")) {
        localPath = path.join(
          process.cwd(),
          "temp",
          `${jobId}_map_validate.mp4`
        );
        await this.s3Service.downloadFile(videoPath, localPath);
        await this.resourceManager.trackResource(localPath);
      }

      await fs.access(localPath, fs.constants.R_OK);

      const stats = await fs.stat(localPath);
      if (stats.size < 1024) {
        logger.warn(`[${jobId}] Map video file too small`, {
          size: stats.size,
          path: videoPath,
        });
        return false;
      }

      const duration = await videoProcessingService.getVideoDuration(localPath);
      if (duration < 1) {
        logger.warn(`[${jobId}] Map video duration too short`, {
          duration,
          path: videoPath,
        });
        return false;
      }

      const isIntegrityValid =
        await videoProcessingService.validateVideoIntegrity(localPath);
      if (!isIntegrityValid) {
        logger.warn(`[${jobId}] Map video integrity check failed`, {
          path: videoPath,
        });
        return false;
      }

      const metadata = await videoProcessingService.getVideoMetadata(localPath);
      logger.debug(`[${jobId}] Video metadata before validation`, {
        path: videoPath,
        fullMetadata: metadata, // Log full metadata for debugging
      });

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
      }

      if (videoPath.startsWith("https://")) {
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
        metadata,
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

  // Helper method to run FFprobe (you may need to install ffprobe or use a library like fluent-ffmpeg for this)
  private async runFFprobe(filePath: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err: Error | null, metadata: FfprobeData) => {
        if (err) reject(err);
        else resolve(metadata);
      });
    });
  }

  private async uploadToS3(filePath: string, s3Key: string): Promise<string> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const region = process.env.AWS_REGION || "us-east-2";
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await resourceManager.trackResource(filePath, "s3-upload");
        await resourceManager.updateResourceState(
          filePath,
          ResourceState.PROCESSING,
          {
            operation: "upload",
            s3Key,
            attempt,
          }
        );

        // Verify file exists and is readable before upload
        await fs.access(filePath, fs.constants.R_OK);
        const stats = await fs.stat(filePath);
        if (stats.size === 0) {
          throw new Error("File is empty");
        }

        const fileStream = createReadStream(filePath);
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: bucket,
            Key: s3Key,
            Body: fileStream,
            ContentType: this.getContentType(filePath),
          },
          tags: [{ Key: "source", Value: "production-pipeline" }],
        });

        await upload.done();
        const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;

        // Verify upload success with metadata check
        const headCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: s3Key,
        });

        const headResponse = await this.s3Client.send(headCommand);

        if (!headResponse.ContentLength || headResponse.ContentLength === 0) {
          throw new Error("Uploaded file is empty");
        }

        if (headResponse.ContentLength !== stats.size) {
          throw new Error(
            `Upload size mismatch: expected ${stats.size}, got ${headResponse.ContentLength}`
          );
        }

        await resourceManager.updateResourceState(
          filePath,
          ResourceState.UPLOADED,
          {
            s3Url,
            contentLength: headResponse.ContentLength,
            contentType: headResponse.ContentType,
          }
        );

        logger.info("Successfully uploaded file to S3", {
          filePath,
          s3Key,
          attempt,
          size: stats.size,
          contentType: headResponse.ContentType,
        });

        return s3Url;
      } catch (error) {
        const isLastAttempt = attempt === MAX_RETRIES;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        logger.warn("S3 upload attempt failed", {
          error: errorMessage,
          filePath,
          s3Key,
          attempt,
          isLastAttempt,
          stack: error instanceof Error ? error.stack : undefined,
        });

        await resourceManager.updateResourceState(
          filePath,
          isLastAttempt ? ResourceState.FAILED : ResourceState.PROCESSING,
          {
            error: errorMessage,
            attempt,
          }
        );

        if (isLastAttempt) {
          throw new Error(
            `Failed to upload ${filePath} to S3 after ${MAX_RETRIES} attempts: ${errorMessage}`
          );
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random()),
          10000
        );
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Clean up any partial upload
        try {
          await this.s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: s3Key,
            })
          );
        } catch (cleanupError) {
          logger.warn("Failed to cleanup partial upload", {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : "Unknown error",
            s3Key,
            attempt,
          });
        }
      }
    }

    throw new Error("Upload failed after retries");
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

  private async processRunwayVideo(
    jobId: string,
    video: ProcessingVideo
  ): Promise<void> {
    logger.info(`[${jobId}] Processing runway video`, {
      order: video.order,
      path: video.path,
    });

    // Implement the actual video processing logic here
    // This would include the existing logic from handleNormalProcessing
    // but adapted for a single video
  }

  private async processVisionImage(
    jobId: string,
    image: ProcessingImage
  ): Promise<void> {
    logger.info(`[${jobId}] Processing vision image`, {
      order: image.order,
      path: image.path,
    });

    // Implement the actual image processing logic here
    // This would include the existing logic from the original processImage function
    // but adapted for a single image
  }

  // Add this helper function
  private async validateClipDuration(
    clip: VideoClip,
    index: number,
    jobId: string,
    template?: ReelTemplate
  ): Promise<boolean> {
    try {
      const duration = await videoProcessingService.getVideoDuration(clip.path);

      // Get expected duration from template if available
      const expectedDuration = template?.durations[index];
      const requestedDuration = clip.duration;

      // If the requested duration is longer than actual video duration
      if (requestedDuration > duration) {
        logger.warn(
          `[${jobId}] Clip ${index} requested duration exceeds actual duration`,
          {
            clipPath: clip.path,
            requestedDuration,
            actualDuration: duration,
            templateDuration: expectedDuration,
          }
        );

        // Adjust the clip duration to actual duration
        clip.duration = duration;
      }

      return true;
    } catch (error) {
      logger.error(`[${jobId}] Failed to validate clip ${index} duration`, {
        clipPath: clip.path,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  // In your existing clip processing code
  private async processClips(
    clips: VideoClip[],
    jobId: string,
    outputPath: string,
    template: ReelTemplate
  ): Promise<void> {
    // Validate all clips first
    const validationResults = await Promise.all(
      clips.map((clip, index) =>
        this.validateClipDuration(clip, index, jobId, template)
      )
    );

    // Filter out invalid clips
    const validClips = clips.filter((_, index) => validationResults[index]);

    if (validClips.length === 0) {
      throw new Error("No valid clips available for processing");
    }

    if (validClips.length < clips.length) {
      logger.warn(`[${jobId}] Some clips were invalid and will be skipped`, {
        originalCount: clips.length,
        validCount: validClips.length,
      });
    }

    // Continue with processing using validClips
    await videoProcessingService.createVideoFromClips(
      validClips,
      outputPath,
      template
    );
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

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
