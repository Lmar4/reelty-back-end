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
import { videoProcessingService } from "../video/video-processing.service.js";
import { reelTemplates, TemplateKey } from "./templates/types.js";
import { ImageOptimizationOptions, VisionProcessor } from "./visionProcessor.js";
import {
  VideoTemplate,
  WatermarkConfig,
} from "../video/video-template.service.js";
import { existsSync } from "fs";
import { VideoTemplateService } from "../video/video-template.service.js";
import { ReelTemplate } from "./templates/types.js";
import { VideoClip } from "../video/video-processing.service.js";

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
          await fs.access(file);
          await fs.unlink(file);
          logger.debug(`Deleted temporary file: ${file}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(`Failed to cleanup ${file}:`, error);
          }
        }
      })
    );
    this.tempFiles.clear();
  }
}

export class ProductionPipeline {
  private readonly MEMORY_WARNING_THRESHOLD = 0.7; // 70% memory usage triggers warning
  private readonly MEMORY_CRITICAL_THRESHOLD = 0.8; // 80% memory usage triggers reduction
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

  private async retryRunwayGeneration(
    inputUrl: string,
    index: number,
    listingId: string,
    jobId: string,
    attempt = 1
  ): Promise<string | null> {
    try {
      logger.info(
        `[${jobId}] Attempting Runway generation (attempt ${attempt}/${this.MAX_RUNWAY_RETRIES})`,
        {
          index,
          inputUrl,
        }
      );

      // Track the input resource
      await resourceManager.trackResource(inputUrl, "runway-input");
      await resourceManager.updateResourceState(
        inputUrl,
        ResourceState.PROCESSING,
        {
          operation: "runway-generation",
          attempt,
        }
      );

      // Generate video directly to S3
      const s3Url = await runwayService.generateVideo(
        inputUrl,
        index,
        listingId,
        jobId
      );

      if (!s3Url) {
        throw new Error("Runway returned no S3 URL");
      }

      // Verify the S3 asset exists and is valid
      const s3Key = this.getS3KeyFromUrl(s3Url);
      const exists = await this.verifyS3Asset(s3Key);
      if (!exists) {
        throw new Error(`Generated video not accessible at ${s3Url}`);
      }

      // Validate video integrity
      const tempPath = path.join(
        process.cwd(),
        "temp",
        `${jobId}_validate_${index}.mp4`
      );
      await this.resourceManager.trackResource(tempPath);

      let duration: number;
      try {
        // Download for validation
        await this.s3Service.downloadFile(s3Url, tempPath);

        // Check video duration and integrity
        duration = await videoProcessingService.getVideoDuration(tempPath);
        if (duration <= 0) {
          throw new Error(
            `Invalid video duration (${duration}s) from Runway output`
          );
        }

        // Additional integrity check
        const isValid = await videoProcessingService.validateVideoIntegrity(
          tempPath
        );
        if (!isValid) {
          throw new Error("Video file integrity check failed");
        }

        logger.info(`[${jobId}] Validated Runway output`, {
          index,
          duration,
          s3Url,
        });
      } finally {
        // Clean up temp file
        await fs.unlink(tempPath).catch((error) => {
          logger.warn(`[${jobId}] Failed to cleanup validation file`, {
            path: tempPath,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        });
      }

      // Update resource state to uploaded
      await resourceManager.updateResourceState(
        inputUrl,
        ResourceState.UPLOADED,
        {
          s3Url,
          validationStatus: "success",
          duration: duration,
        }
      );

      // Update the Photo record with the Runway video URL and metadata
      await this.prisma.photo.updateMany({
        where: {
          listingId,
          order: index,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        data: {
          runwayVideoPath: s3Url,
          status: "COMPLETED",
          updatedAt: new Date(),
          metadata: {
            runwayGeneratedAt: new Date().toISOString(),
            inputProcessedPath: inputUrl,
            attempt,
            generatedAt: new Date().toISOString(),
            validationStatus: "success",
            duration,
          },
        },
      });

      logger.info(`[${jobId}] Stored Runway video URL for photo`, {
        listingId,
        order: index,
        s3Url,
        duration,
      });

      return s3Url;
    } catch (error) {
      const isLastAttempt = attempt >= this.MAX_RUNWAY_RETRIES;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        `[${jobId}] Runway generation attempt ${attempt} failed${
          isLastAttempt ? " (final attempt)" : ""
        }`,
        {
          error: errorMessage,
          index,
          inputUrl,
          stack: error instanceof Error ? error.stack : undefined,
        }
      );

      await resourceManager.updateResourceState(
        inputUrl,
        isLastAttempt ? ResourceState.FAILED : ResourceState.PROCESSING,
        {
          error: errorMessage,
          attempt,
        }
      );

      if (isLastAttempt) {
        return null;
      }

      const delay =
        this.INITIAL_RETRY_DELAY *
        Math.pow(2, attempt - 1) *
        (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.retryRunwayGeneration(
        inputUrl,
        index,
        listingId,
        jobId,
        attempt + 1
      );
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

    const isRegeneration = options?.isRegeneration ?? false;
    const forceRegeneration = options?.forceRegeneration ?? false;
    const regenerationContext = options?.regenerationContext;

    logger.info(`[${jobId}] Processing runway videos`, {
      isRegeneration,
      forceRegeneration,
      photoIds: regenerationContext?.photosToRegenerate?.map((p) => p.id),
      listingId: job.listingId,
    });

    // Fetch all photos for the listing, ordered by `order`
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
      photos: allPhotos.map((p) => ({
        id: p.id,
        order: p.order,
        hasRunway: !!p.runwayVideoPath,
        status: p.status,
      })),
    });

    if (isRegeneration && regenerationContext) {
      const { photosToRegenerate, existingPhotos } = regenerationContext;

      logger.info(`[${jobId}] Processing regeneration`, {
        photosToRegenerateCount: photosToRegenerate.length,
        photosToRegenerate: photosToRegenerate.map((p) => ({
          id: p.id,
          order: p.order,
          hasProcessedPath: !!p.processedFilePath,
        })),
      });

      // Initialize runwayVideos with existing videos first
      const runwayVideos = new Array(10).fill(null);
      existingPhotos.forEach((photo) => {
        if (photo.runwayVideoPath) {
          runwayVideos[photo.order] = photo.runwayVideoPath;
          logger.info(`[${jobId}] Using existing runway video`, {
            order: photo.order,
            path: photo.runwayVideoPath,
            photoId: photo.id,
          });
        }
      });

      // Process only the photos that need regeneration
      const processedVideos = await Promise.all(
        photosToRegenerate.map(async (photo) => {
          let inputPath: string | null = photo.processedFilePath;
          if (
            !inputPath ||
            !(await this.verifyS3VideoAccess(inputPath, jobId))
          ) {
            logger.info(`[${jobId}] Falling back to vision processing`, {
              photoId: photo.id,
              order: photo.order,
              originalPath: inputPath,
            });

            inputPath = await this.processVisionImageFallback(
              this.getS3KeyFromUrl(photo.filePath),
              photo.order,
              jobId,
              job.listingId
            );
          }
          if (inputPath) {
            const runwayVideo = await this.retryRunwayGeneration(
              inputPath,
              photo.order,
              job.listingId,
              jobId
            );
            return { order: photo.order, path: runwayVideo || null };
          }
          return { order: photo.order, path: null };
        })
      );

      // Replace only the regenerated videos in our array
      processedVideos.forEach((video) => {
        if (video.path) {
          runwayVideos[video.order] = video.path;
          logger.info(`[${jobId}] Replaced with regenerated runway video`, {
            order: video.order,
            path: video.path,
          });
        } else {
          logger.warn(`[${jobId}] Failed to regenerate video`, {
            order: video.order,
          });
        }
      });

      // Log and return the full set of videos
      logger.debug(`[${jobId}] Final runway videos for regeneration`, {
        runwayVideos,
        total: runwayVideos.length,
        nonNullCount: runwayVideos.filter((v) => v !== null).length,
      });
      return runwayVideos;
    }

    // Non-regeneration flow (normal processing)
    return this.handleNormalProcessing(
      inputFiles,
      jobId,
      job.listingId,
      [],
      new Map()
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

  private async processTemplate(
    template: TemplateKey,
    runwayVideos: string[],
    jobId: string,
    listingId: string,
    coordinates?: { lat: number; lng: number },
    mapVideo?: string | null
  ): Promise<TemplateProcessingResult> {
    const startTime = Date.now();

    // Get the user's subscription tier to check watermark settings
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        user: {
          select: {
            currentTier: true,
          },
        },
      },
    });

    const userTier = job?.user?.currentTier;
    const shouldShowWatermark = userTier?.hasWatermark ?? true; // Default to showing watermark if no tier

    // Resolve watermark only if the user's tier requires it
    let watermarkConfig: WatermarkConfig | undefined;
    if (shouldShowWatermark) {
      const localWatermarkPath = await this.getSharedWatermarkPath(jobId);
      if (localWatermarkPath) {
        try {
          await fs.access(localWatermarkPath);
          watermarkConfig = {
            path: localWatermarkPath,
            position: { x: "(main_w-overlay_w)/2", y: "main_h-overlay_h-300" },
          };

          logger.info(
            `[${jobId}] Applying watermark based on subscription tier`,
            {
              tierId: userTier?.tierId,
              hasWatermark: userTier?.hasWatermark,
            }
          );
        } catch (error) {
          logger.warn(
            `[${jobId}] Watermark file inaccessible, proceeding without`,
            {
              path: localWatermarkPath,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
        }
      }
    } else {
      logger.info(`[${jobId}] Skipping watermark based on subscription tier`, {
        tierId: userTier?.tierId,
        hasWatermark: userTier?.hasWatermark,
      });
    }

    const tempDir = path.join(process.cwd(), "temp", `${jobId}_${template}`);
    const videoTemplateService = VideoTemplateService.getInstance();

    try {
      await fs.mkdir(tempDir, { recursive: true });

      const templateConfig = reelTemplates[template];

      // 1. Improved Duration Array Handling - do it early and validate
      const durations = Array.isArray(templateConfig.durations)
        ? templateConfig.durations
        : Object.values(templateConfig.durations);

      if (!durations.length) {
        throw new Error(`Template ${template} has no valid durations defined`);
      }

      // Validate all durations are positive numbers
      if (durations.some((d) => typeof d !== "number" || d <= 0)) {
        throw new Error(`Template ${template} has invalid duration values`);
      }

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

      // Download and validate runway videos
      const localVideos = await Promise.all(
        runwayVideos.map(async (video, index) => {
          const localPath = path.join(tempDir, `segment_${index}.mp4`);
          try {
            await this.s3Service.downloadFile(video, localPath);
            const duration = await videoProcessingService.getVideoDuration(
              localPath
            );
            if (duration <= 0) throw new Error("Invalid video duration");
            await this.resourceManager.trackResource(localPath);
            return localPath;
          } catch (error) {
            logger.warn(`[${jobId}] Skipping corrupt or inaccessible video`, {
              index,
              path: video,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return null;
          }
        })
      );

      const validLocalVideos = localVideos.filter((v): v is string => !!v);
      if (validLocalVideos.length === 0) {
        throw new Error("No valid videos available for template processing");
      }

      // Handle map video with improved validation
      let localMapVideo: string | undefined;
      let mapDuration: number | undefined;
      if (needsMap && mapVideo) {
        localMapVideo = path.join(tempDir, "map.mp4");
        try {
          await this.s3Service.downloadFile(mapVideo, localMapVideo);
          mapDuration = await videoProcessingService.getVideoDuration(
            localMapVideo
          );
          if (mapDuration <= 0) throw new Error("Invalid map video duration");
          await this.resourceManager.trackResource(localMapVideo);
        } catch (error) {
          logger.warn(`[${jobId}] Map video inaccessible, proceeding without`, {
            path: mapVideo,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          localMapVideo = undefined;
        }
      }

      // Resolve music
      let resolvedMusic: ReelTemplate["music"] | undefined =
        templateConfig.music;
      if (templateConfig.music?.path) {
        const musicPath = path.join(tempDir, `music_${template}.mp3`);
        try {
          const resolvedMusicPath = await videoTemplateService.resolveAssetPath(
            templateConfig.music.path,
            "music",
            true
          );
          if (resolvedMusicPath) {
            await this.s3Service.downloadFile(resolvedMusicPath, musicPath);
            const duration = await videoProcessingService.getVideoDuration(
              musicPath
            );
            if (duration <= 0) throw new Error("Invalid music file duration");
            await this.resourceManager.trackResource(musicPath);
            resolvedMusic = {
              ...templateConfig.music,
              path: musicPath,
              isValid: true,
            };
          }
        } catch (error) {
          logger.warn(`[${jobId}] Music file issue, proceeding without`, {
            path: templateConfig.music.path,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          resolvedMusic = undefined;
        }
      }

      // 2. Segment Count Control & 3. Duration-Sequence Alignment
      const combinedVideos: string[] = [];
      const adjustedDurations: number[] = [];
      const sequenceMapping: Array<{
        type: string;
        source: string;
        duration: number;
      }> = [];
      let segmentCount = 0;
      const maxSegments = validLocalVideos.length;

      for (const item of templateConfig.sequence) {
        // 4. Improved Map Video Handling
        if (item === "map" && localMapVideo) {
          const mapDurationValue =
            typeof templateConfig.durations === "object"
              ? (templateConfig.durations as Record<string, number>).map
              : durations[segmentCount];

          if (!mapDurationValue) {
            logger.warn(
              `[${jobId}] No duration specified for map video, skipping`
            );
            continue;
          }

          combinedVideos.push(localMapVideo);
          adjustedDurations.push(mapDurationValue);
          sequenceMapping.push({
            type: "map",
            source: localMapVideo,
            duration: mapDurationValue,
          });
        } else {
          if (segmentCount >= maxSegments) {
            logger.info(
              `[${jobId}] Reached maximum available segments (${maxSegments})`
            );
            break;
          }

          const videoIndex = typeof item === "string" ? parseInt(item) : item;
          if (videoIndex < validLocalVideos.length) {
            const duration = durations[segmentCount];

            // 5. Stricter Validation
            if (!duration) {
              logger.warn(
                `[${jobId}] No duration specified for segment ${segmentCount}, skipping`
              );
              continue;
            }

            combinedVideos.push(validLocalVideos[videoIndex]);
            adjustedDurations.push(duration);
            sequenceMapping.push({
              type: "runway",
              source: `video_${videoIndex}`,
              duration,
            });
            segmentCount++;
          }
        }
      }

      // Enhanced logging with duration information
      logger.info(`[${jobId}] Clip sequence for ${template}`, {
        template,
        sequence: templateConfig.sequence,
        sequenceMapping,
        combinedVideos: combinedVideos.map((path, idx) => ({
          index: idx,
          path,
          duration: adjustedDurations[idx],
          isMap: path === localMapVideo,
        })),
        totalClips: combinedVideos.length,
        expectedTotal: templateConfig.sequence.length,
        totalDuration: adjustedDurations.reduce((sum, d) => sum + d, 0),
      });

      if (combinedVideos.length === 0) {
        throw new Error("No valid clips generated for template");
      }

      // Create clips with validated durations
      const clips = combinedVideos.map((path, index) => {
        const duration = adjustedDurations[index];
        if (duration === undefined) {
          throw new Error(`No duration defined for clip ${index}: ${path}`);
        }
        return {
          path,
          duration,
          transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
          colorCorrection: templateConfig.colorCorrection,
        };
      });

      const outputPath = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/properties/${listingId}/videos/templates/${jobId}/${template}.mp4`;

      await videoProcessingService.stitchVideos(
        clips,
        outputPath,
        {
          name: templateConfig.name,
          description: templateConfig.description,
          colorCorrection: templateConfig.colorCorrection,
          transitions: templateConfig.transitions,
          reverseClips: templateConfig.reverseClips,
          music: resolvedMusic,
          outputOptions: ["-q:a 2"],
        } as VideoTemplate,
        watermarkConfig
      );

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: template,
        progress: 100,
        message: `${template} template completed`,
      });

      return {
        template,
        status: "SUCCESS",
        outputPath,
        processingTime: Date.now() - startTime,
      };
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
    } finally {
      // Cleanup moved to execute, but log here for visibility
      logger.debug(`[${jobId}] Temp directory ready for cleanup`, { tempDir });
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
    const filteredTemplates = templates.filter((t) => {
      const needsMap = reelTemplates[t].sequence.includes("map");
      if (needsMap && !mapVideo) {
        logger.info(
          `[${jobId}] Skipping template ${t} due to missing map video`
        );
        return false;
      }
      return true;
    });

    const templatePromises = filteredTemplates.map((template) =>
      this.limit(() =>
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

    const results = await Promise.allSettled(templatePromises);
    const successfulResults = results
      .filter(
        (r): r is PromiseFulfilledResult<TemplateProcessingResult> =>
          r.status === "fulfilled" &&
          r.value.status === "SUCCESS" &&
          !!r.value.outputPath
      )
      .map((r) => r.value.outputPath!);

    const failedResults = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    failedResults.forEach((r) => {
      logger.error(`[${jobId}] Template processing rejected`, {
        reason: r.reason instanceof Error ? r.reason.message : "Unknown error",
      });
    });

    if (successfulResults.length === 0) {
      throw new Error("No templates processed successfully");
    }

    logger.info(`[${jobId}] Template processing completed`, {
      successful: successfulResults.length,
      failed: filteredTemplates.length - successfulResults.length,
      total: filteredTemplates.length,
    });

    return successfulResults;
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

    try {
      if (isRegeneration && regenerationContext) {
        const { photosToRegenerate } = regenerationContext;

        const processedImages = await Promise.all(
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

            // Update existing photo
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

            return {
              order: photo.order,
              path: processedPath,
              id: photo.id,
            };
          })
        );

        return processedImages;
      } else {
        // Non-regeneration flow - process new images
        const processedImages = await Promise.all(
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
              where: {
                listingId: job.listingId,
                order: index,
              },
            });

            // Create new photo record
            await this.prisma.photo.upsert({
              where: {
                id: existingPhoto?.id || "", // Use the found ID or handle creation
              },
              update: {
                processedFilePath: processedPath,
                status: "COMPLETED",
                updatedAt: new Date(),
                metadata: {
                  visionProcessedAt: new Date().toISOString(),
                },
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

            return {
              order: index,
              path: processedPath,
            };
          })
        );

        return processedImages;
      }
    } catch (error) {
      logger.error(`[${jobId}] Failed to process vision images`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        isRegeneration,
      });
      throw error;
    }
  }

  private async acquireListingLock(
    jobId: string,
    listingId: string
  ): Promise<boolean> {
    const lockKeyHex = crypto
      .createHash("sha256")
      .update(listingId)
      .digest("hex")
      .slice(0, 8);
    const lockKeyNum = Math.abs(parseInt(lockKeyHex, 16)) % 2 ** 31;

    try {
      // Start a transaction to make lock acquisition atomic
      return await this.prisma.$transaction(async (tx) => {
        // Try to acquire advisory lock
        const result = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_lock(${lockKeyNum}::bigint) AS locked;
        `;

        const locked = result[0].locked;
        if (!locked) {
          logger.info({
            message: `[${jobId}] Listing ${listingId} already locked`,
            jobId,
            listingId,
          });
          return false;
        }

        try {
          // Try to create database lock
          await tx.listingLock.create({
            data: {
              listingId,
              jobId,
              processId: process.pid.toString(),
              expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
            },
          });

          return true;
        } catch (dbError) {
          // If database lock fails, release advisory lock
          await tx.$queryRaw`SELECT pg_advisory_unlock(${lockKeyNum}::bigint)`;
          throw dbError;
        }
      });
    } catch (error) {
      logger.error(`[${jobId}] Failed to acquire listing lock`, {
        error: error instanceof Error ? error.message : "Unknown error",
        jobId,
        listingId,
      });

      // Ensure advisory lock is released in case transaction failed
      try {
        await this.prisma
          .$queryRaw`SELECT pg_advisory_unlock(${lockKeyNum}::bigint)`;
      } catch (unlockError) {
        logger.error(`[${jobId}] Failed to release advisory lock after error`, {
          error:
            unlockError instanceof Error
              ? unlockError.message
              : "Unknown error",
          jobId,
          listingId,
        });
      }

      return false;
    }
  }

  private async releaseListingLock(
    jobId: string,
    listingId: string
  ): Promise<void> {
    const lockKeyHex = crypto
      .createHash("sha256")
      .update(listingId)
      .digest("hex")
      .slice(0, 8);
    const lockKeyNum = Math.abs(parseInt(lockKeyHex, 16)) % 2 ** 31;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Delete database lock
        await tx.listingLock.deleteMany({
          where: {
            listingId,
            jobId,
            processId: process.pid.toString(),
          },
        });

        // Release advisory lock
        await tx.$queryRaw`SELECT pg_advisory_unlock(${lockKeyNum}::bigint)`;
      });
    } catch (error) {
      logger.error(`[${jobId}] Failed to release listing lock`, {
        error: error instanceof Error ? error.message : "Unknown error",
        jobId,
        listingId,
      });
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

    // Update job metadata with regeneration info if applicable
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

      // Log job state
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

      await this.processVisionImages(jobId);

      let runwayVideos: string[] = [];
      const options = {
        isRegeneration,
        forceRegeneration,
        regenerationContext,
      };

      if (!input.skipRunwayIfCached) {
        runwayVideos = await this.processRunwayVideos(
          jobId,
          inputFiles,
          options
        );
      } else {
        const existingVideos = await this.prisma.photo.findMany({
          where: { listingId, runwayVideoPath: { not: null } },
          orderBy: { order: "asc" },
          select: { runwayVideoPath: true, order: true },
        });

        if (
          existingVideos.length === input.inputFiles.length &&
          !isRegeneration // Skip cache if regenerating
        ) {
          runwayVideos = existingVideos.map((v) => v.runwayVideoPath!);
          logger.info(`[${jobId}] Using cached Runway videos`, {
            count: runwayVideos.length,
          });
        } else {
          runwayVideos = await this.processRunwayVideos(
            jobId,
            inputFiles,
            options
          );
        }
      }

      logger.debug(`[${jobId}] Runway videos generated`, { runwayVideos });

      const mapVideo = input.coordinates
        ? await this.generateMapVideoForTemplate(
            input.coordinates,
            jobId,
            listingId
          )
        : null;

      const templateResults = await this.processTemplatesForSpecific(
        runwayVideos,
        jobId,
        listingId,
        Object.keys(reelTemplates) as TemplateKey[],
        input.coordinates,
        mapVideo
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
      // Enhanced error logging with explicit details
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`[${jobId}] Pipeline execution failed`, {
        error: errorMessage,
        stack: errorStack,
        input: {
          jobId,
          listingId: input.listingId,
          inputFiles: input.inputFiles,
          isRegeneration: input.isRegeneration,
          forceRegeneration: input.forceRegeneration,
          regenerationContext: input.regenerationContext
            ? {
                existingPhotosCount:
                  input.regenerationContext.existingPhotos.length,
                photosToRegenerate:
                  input.regenerationContext.photosToRegenerate.map((p) => ({
                    id: p.id,
                    order: p.order,
                  })),
                totalPhotos: input.regenerationContext.totalPhotos,
              }
            : null,
          skipRunwayIfCached: input.skipRunwayIfCached,
          skipLock: input.skipLock,
          coordinates: input.coordinates,
          template: input.template,
        },
        timestamp: new Date().toISOString(),
      });

      // Update job status with failure details
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
            isRegeneration: input.isRegeneration,
            forceRegeneration: input.forceRegeneration,
            regenerationContext: input.regenerationContext
              ? JSON.parse(JSON.stringify(input.regenerationContext))
              : null,
            skipRunwayIfCached: input.skipRunwayIfCached,
            skipLock: input.skipLock,
          } satisfies Prisma.InputJsonValue,
        },
      });

      throw error;
    } finally {
      // Enhanced cleanup logging
      try {
        const resourcesBeforeCleanup: string[] = Array.from(
          this.resourceManager.tempFiles
        );
        logger.debug(`[${jobId}] Starting cleanup`, {
          tempDir,
          activeResourcesCount: resourcesBeforeCleanup.length,
          activeResources: resourcesBeforeCleanup.map((resource: string) => ({
            path: resource, // Just the path, as it's a string
          })),
        });

        await this.resourceManager.cleanup();

        if (existsSync(tempDir)) {
          const filesInTempDir = await fs.readdir(tempDir);
          logger.info(`[${jobId}] Cleaning up temp directory`, {
            tempDir,
            fileCount: filesInTempDir.length,
            files: filesInTempDir,
          });
          await fs.rm(tempDir, { recursive: true, force: true });
          logger.info(`[${jobId}] Successfully cleaned up temp directory`, {
            tempDir,
            timestamp: new Date().toISOString(),
          });
        } else {
          logger.debug(`[${jobId}] No temp directory to clean up`, { tempDir });
        }
      } catch (cleanupError) {
        const cleanupErrorMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : "Unknown cleanup error";
        const cleanupErrorStack =
          cleanupError instanceof Error ? cleanupError.stack : undefined;
        logger.warn(`[${jobId}] Failed to cleanup resources`, {
          error: cleanupErrorMessage,
          stack: cleanupErrorStack,
          tempDir,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private checkMemoryUsage(jobId: string): void {
    const used = process.memoryUsage();
    const heapUsed = used.heapUsed / 1024 / 1024; // Convert to MB
    const heapTotal = used.heapTotal / 1024 / 1024; // Convert to MB
    const heapUsage = used.heapUsed / used.heapTotal;

    const memoryInfo = {
      heapUsed: `${heapUsed.toFixed(2)} MB`,
      heapTotal: `${heapTotal.toFixed(2)} MB`,
      usage: `${(heapUsage * 100).toFixed(1)}%`,
      rss: `${(used.rss / 1024 / 1024).toFixed(2)} MB`,
    };

    if (heapUsage > this.MEMORY_CRITICAL_THRESHOLD && heapTotal > 1000) {
      // Only reduce batch size if total heap is above 1GB
      const newBatchSize = Math.max(
        this.MIN_BATCH_SIZE,
        Math.floor(this.currentBatchSize / 2)
      );
      if (newBatchSize !== this.currentBatchSize) {
        this.currentBatchSize = newBatchSize;
        this.limit = pLimit(this.currentBatchSize);
        logger.warn(
          `[${jobId}] Reducing batch size due to critical memory usage`,
          {
            ...memoryInfo,
            newBatchSize: this.currentBatchSize,
            action: "REDUCE_BATCH_SIZE",
          }
        );
      }
    } else if (heapUsage > this.MEMORY_WARNING_THRESHOLD && heapTotal > 1000) {
      logger.warn(`[${jobId}] High memory usage detected`, {
        ...memoryInfo,
        currentBatchSize: this.currentBatchSize,
        action: "WARNING",
      });
    } else if (this.currentBatchSize < this.DEFAULT_BATCH_SIZE) {
      const newBatchSize = Math.min(
        this.DEFAULT_BATCH_SIZE,
        this.currentBatchSize + 1
      );
      if (newBatchSize !== this.currentBatchSize) {
        this.currentBatchSize = newBatchSize;
        this.limit = pLimit(this.currentBatchSize);
        logger.info(
          `[${jobId}] Increasing batch size due to normal memory usage`,
          {
            ...memoryInfo,
            newBatchSize: this.currentBatchSize,
            action: "INCREASE_BATCH_SIZE",
          }
        );
      }
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
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt > retries) throw error;
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
    throw new Error(`${context} failed after ${retries} retries`);
  }

  private async generateMapVideoForTemplate(
    coordinates: { lat: number; lng: number },
    jobId: string,
    listingId: string
  ): Promise<string | null> {
    const MAP_GENERATION_TIMEOUT = 120000;
    const cacheKey = `map_${jobId}_${crypto
      .createHash("md5")
      .update(`${coordinates.lat},${coordinates.lng}`)
      .digest("hex")}`;
    const tempS3Key = `temp/maps/${jobId}/${Date.now()}.mp4`;

    try {
      // Check cache first
      const cachedPath = await this.getCachedAsset(cacheKey, "map");
      if (cachedPath) {
        const exists = await this.verifyS3Asset(
          this.getS3KeyFromUrl(cachedPath)
        );
        if (exists) {
          logger.info(`[${jobId}] Using cached map video from S3`, {
            cachedPath,
          });
          return this.validateS3Url(cachedPath);
        } else {
          // If cached path is local (not S3), upload it to temp location
          if (!cachedPath.startsWith("https://")) {
            logger.info(
              `[${jobId}] Uploading cached local map video to temp S3`,
              {
                cachedPath,
                tempS3Key,
              }
            );
            const fileBuffer = await fs.readFile(cachedPath);
            await this.s3VideoService.uploadFile(fileBuffer, tempS3Key);
          } else {
            logger.warn(`[${jobId}] Cached S3 file not found, regenerating`, {
              cachedPath,
            });
          }
        }
      }

      logger.info(`[${jobId}] Starting map video generation`, {
        coordinates,
        cacheKey,
      });

      // Generate map video if no valid cache
      const localVideoPath = cachedPath?.startsWith("https://")
        ? null
        : cachedPath ||
          (await this.retryWithBackoff(
            async () => {
              return Promise.race([
                mapCaptureService.generateMapVideo(coordinates, jobId),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error("Map video generation timeout")),
                    MAP_GENERATION_TIMEOUT
                  )
                ),
              ]);
            },
            2,
            "Map video generation",
            jobId
          ));

      // Upload to temp location if not already done
      if (localVideoPath && !cachedPath?.startsWith("https://")) {
        const fileBuffer = await fs.readFile(localVideoPath);
        await this.s3VideoService.uploadFile(fileBuffer, tempS3Key);
      }

      // Move to final location
      const finalS3Url = await this.s3VideoService.moveFromTempToListing(
        tempS3Key,
        listingId,
        jobId
      );
      logger.info(`[${jobId}] Verifying map video before caching`, {
        finalS3Url,
      });
      const exists = await this.verifyS3Asset(this.getS3KeyFromUrl(finalS3Url));
      if (!exists)
        throw new Error(`Map video not accessible after move: ${finalS3Url}`);
      await this.cacheAsset(jobId, cacheKey, finalS3Url, "map");

      logger.info(`[${jobId}] Map video generation completed`, {
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
    existingPhotos: any[],
    verifiedVideos: Map<number, string>
  ): Promise<string[]> {
    const runwayVideos = new Array(inputFiles.length).fill(null);
    existingPhotos.forEach((photo) => {
      const verifiedVideo = verifiedVideos.get(photo.order);
      if (verifiedVideo && photo.order < inputFiles.length) {
        runwayVideos[photo.order] = verifiedVideo;
        logger.info(`[${jobId}] Using verified video for normal processing`, {
          order: photo.order,
          path: verifiedVideo,
        });
      }
    });

    const missingIndices = runwayVideos
      .map((v, i) => (v === null ? i : -1))
      .filter((i) => i !== -1);

    const results = await Promise.all(
      missingIndices.map(async (index) =>
        this.limit(() =>
          this.retryRunwayGeneration(
            inputFiles[index],
            index,
            listingId,
            jobId
          ).then((result) => ({ index, path: result }))
        )
      )
    );

    results.forEach((result) => {
      if (result?.path) runwayVideos[result.index] = result.path;
    });

    return runwayVideos.filter(
      (v): v is string => !!v && v.toLowerCase().endsWith(".mp4")
    );
  }

  private async getRunwayVideos(jobId: string): Promise<ProcessingVideo[]> {
    // First get the listingId from the job
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { listingId: true },
    });

    if (!job) return [];

    const videos = await this.prisma.photo.findMany({
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

    return videos.map((v) => ({
      id: v.id,
      order: v.order,
      path: v.runwayVideoPath!,
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
    // ... existing implementation ...
  }
}
