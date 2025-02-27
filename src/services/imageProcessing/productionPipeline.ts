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
      logger.info(
        `[${jobId}] Attempting Runway generation (attempt ${attempt}/${this.MAX_RUNWAY_RETRIES})`,
        { index, inputUrl }
      );

      // Generate video with Runway (with its own retries)
      const s3Url = await runwayService.generateVideo(
        inputUrl,
        index,
        listingId,
        jobId
      );

      if (!s3Url) {
        throw new Error("Runway returned no S3 URL");
      }

      // Verify and validate with cache
      const validationResult = await this.validateWithCache(
        s3Url,
        index,
        jobId
      );

      if (validationResult) {
        // Update the Photo record with the validated Runway video URL
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
              duration: validationResult.duration,
            },
          },
        });

        return {
          s3Url,
          duration: validationResult.duration,
          validated: true,
          metadata: {
            attempt,
            generatedAt: new Date().toISOString(),
          },
        };
      }

      // Si la validación falló pero aún tenemos intentos, reintentamos solo la generación
      if (attempt < this.MAX_RUNWAY_RETRIES) {
        logger.warn(`[${jobId}] Validation failed, retrying generation`, {
          attempt,
          index,
          inputUrl,
        });
        return this.retryRunwayGeneration(
          inputUrl,
          index,
          listingId,
          jobId,
          attempt + 1
        );
      }

      return null;
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

    // Add verification step before retrying
    const verifyRunwayVideo = async (order: number): Promise<boolean> => {
      const photo = await this.prisma.photo.findFirst({
        where: { listingId: job.listingId, order },
        select: { runwayVideoPath: true },
      });
      return !!photo?.runwayVideoPath;
    };

    // Modify the retry logic to check if video actually exists
    const retryRunway = async (
      inputUrl: string,
      index: number
    ): Promise<string | null> => {
      const existingVideo = await verifyRunwayVideo(index);
      if (existingVideo) {
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

      // Initialize runwayVideos based on total photos count
      const maxOrder = Math.max(
        ...existingPhotos.map((p) => p.order),
        ...photosToRegenerate.map((p) => p.order)
      );
      const runwayVideos = new Array(maxOrder + 1);

      // First, process photos that need regeneration to ensure we have all videos
      const processedVideos = await Promise.all(
        photosToRegenerate.map(async (photo) => {
          // Check if there's already a valid runwayVideoPath for this photo
          const existingPhoto = allPhotos.find((p) => p.id === photo.id);
          if (
            existingPhoto?.runwayVideoPath &&
            (await this.verifyS3VideoAccess(
              existingPhoto.runwayVideoPath,
              jobId
            )) &&
            !forceRegeneration
          ) {
            runwayVideos[photo.order] = existingPhoto.runwayVideoPath;
            logger.info(
              `[${jobId}] Reusing existing runwayVideoPath for regeneration, skipping Runway call`,
              {
                photoId: photo.id,
                order: photo.order,
                path: existingPhoto.runwayVideoPath,
              }
            );
            return { order: photo.order, path: existingPhoto.runwayVideoPath };
          }

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
            // Use the new retryRunway function instead of retryRunwayGeneration
            const runwayVideo = await retryRunway(inputPath, photo.order);
            if (!runwayVideo) {
              throw new Error(
                `Failed to generate runway video for photo ${photo.id} at order ${photo.order}`
              );
            }

            // Verify the runwayVideoPath is saved in the database
            const updatedPhoto = await this.prisma.photo.findFirst({
              where: {
                listingId: job.listingId,
                order: photo.order,
                status: "COMPLETED",
              },
              select: { runwayVideoPath: true, id: true },
            });

            if (
              !updatedPhoto?.runwayVideoPath ||
              updatedPhoto.runwayVideoPath !== runwayVideo
            ) {
              logger.error(
                `[${jobId}] runwayVideoPath not saved correctly for photo ${photo.id} at order ${photo.order}`,
                {
                  expected: runwayVideo,
                  actual: updatedPhoto?.runwayVideoPath,
                }
              );
              throw new Error(
                `Failed to save runwayVideoPath for photo ${photo.id}`
              );
            }

            logger.info(
              `[${jobId}] Successfully saved runwayVideoPath for photo ${photo.id} at order ${photo.order}`,
              {
                path: runwayVideo,
              }
            );

            return { order: photo.order, path: runwayVideo };
          }
          throw new Error(
            `No valid input path for photo ${photo.id} at order ${photo.order}`
          );
        })
      );

      // Add regenerated videos to the array
      processedVideos.forEach((video) => {
        runwayVideos[video.order] = video.path;
        logger.info(`[${jobId}] Added regenerated runway video`, {
          order: video.order,
          path: video.path,
        });
      });

      // Fill in existing videos for non-regenerated photos
      existingPhotos.forEach((photo) => {
        if (!photo.runwayVideoPath) {
          throw new Error(
            `Missing runway video for existing photo ${photo.id} at order ${photo.order}`
          );
        }
        if (!processedVideos.some((v) => v.order === photo.order)) {
          runwayVideos[photo.order] = photo.runwayVideoPath;
          logger.info(`[${jobId}] Using existing runway video`, {
            order: photo.order,
            path: photo.runwayVideoPath,
            photoId: photo.id,
          });
        }
      });

      // Verify we have all videos
      const missingVideos = runwayVideos
        .map((v, i) => ({ index: i, hasVideo: !!v }))
        .filter(({ hasVideo }) => !hasVideo);

      if (missingVideos.length > 0) {
        throw new Error(
          `Missing runway videos for positions: ${missingVideos
            .map((v) => v.index)
            .join(", ")}`
        );
      }

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
      allPhotos, // Pass all photos instead of empty array
      new Map(
        allPhotos
          .filter((p) => p.runwayVideoPath !== null)
          .map((p) => [p.order, p.runwayVideoPath!])
      ) // Create Map from existing runwayVideoPaths
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
    const trackedResources: string[] = [];

    try {
      // Registrar todos los recursos
      for (const resource of resources) {
        await this.resourceManager.trackResource(resource.path);
        trackedResources.push(resource.path);

        logger.debug(`[${jobId}] Tracking resource`, {
          path: resource.path,
          type: resource.type,
          metadata: resource.metadata,
        });
      }

      return await operation();
    } finally {
      // Cleanup automático
      for (const path of trackedResources) {
        try {
          if (existsSync(path)) {
            await fs.unlink(path);
            logger.debug(`[${jobId}] Cleaned up resource`, { path });
          }
        } catch (error) {
          logger.warn(`[${jobId}] Failed to cleanup resource`, {
            path,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
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
    const tempDir = path.join(process.cwd(), "temp", `${jobId}_${template}`);
    const videoTemplateService = VideoTemplateService.getInstance();

    try {
      await fs.mkdir(tempDir, { recursive: true });
      const templateConfig = reelTemplates[template];

      // Validar durations temprano
      const durations = Array.isArray(templateConfig.durations)
        ? templateConfig.durations
        : Object.values(templateConfig.durations);

      if (!durations.length) {
        throw new Error(`Template ${template} has no valid durations defined`);
      }

      if (durations.some((d) => typeof d !== "number" || d <= 0)) {
        throw new Error(`Template ${template} has invalid duration values`);
      }

      // Verificar necesidad de mapa
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

      // Procesar videos y recursos dentro del tracking
      return await this.withResourceTracking(
        jobId,
        async () => {
          // Descargar y validar videos
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

          // Procesar video del mapa si es necesario
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

          // Procesar música
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

          // Preparar clips
          const clips = validVideos.map((video, index) => ({
            path: video.path,
            duration: durations[index] || video.duration,
            transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
            colorCorrection: templateConfig.colorCorrection,
          }));

          const outputPath = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/properties/${listingId}/videos/templates/${jobId}/${template}.mp4`;

          // Obtener configuración de watermark
          const watermarkConfig = await this.getSharedWatermarkPath(jobId);
          const watermarkSettings = watermarkConfig
            ? ({
                path: watermarkConfig,
                position: {
                  x: "(main_w-overlay_w)/2",
                  y: "main_h-overlay_h-300",
                },
              } as WatermarkConfig)
            : undefined;

          // Procesar el video
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

          await this.updateJobProgress(jobId, {
            stage: "template",
            subStage: template,
            progress: 100,
            message: `${template} template completed`,
          });

          // Preparar recursos para tracking
          const resources: ResourceTracker[] = [
            ...validVideos.map((v) => ({
              path: v.path,
              type: "video" as const,
            })),
            ...(processedMapVideo
              ? [
                  {
                    path: processedMapVideo.path,
                    type: "video" as const,
                  },
                ]
              : []),
            ...(processedMusic?.path
              ? [
                  {
                    path: processedMusic.path,
                    type: "music" as const,
                  },
                ]
              : []),
          ];

          return {
            template,
            status: "SUCCESS",
            outputPath,
            processingTime: Date.now() - startTime,
          };
        },
        [] // Los recursos se manejan internamente
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
    const lockKeyHex = crypto
      .createHash("sha256")
      .update(listingId)
      .digest("hex")
      .slice(0, 8);
    const lockKeyNum = Math.abs(parseInt(lockKeyHex, 16)) % 2 ** 31;

    let retries = 0;
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second

    // First cleanup any stale locks
    await this.cleanupStaleLocks(listingId);

    while (retries < maxRetries) {
      try {
        // Check for existing valid lock first
        const existingLock = await this.prisma.listingLock.findFirst({
          where: {
            listingId,
            expiresAt: {
              gt: new Date(),
            },
          },
        });

        if (existingLock) {
          logger.info({
            message: `[${jobId}] Listing ${listingId} has valid lock held by job ${existingLock.jobId}`,
            jobId,
            listingId,
            lockHolderId: existingLock.jobId,
          });
          return false;
        }

        // Try to acquire advisory lock
        const advisoryResult = await this.prisma.$queryRaw<
          { locked: boolean }[]
        >`
          SELECT pg_try_advisory_lock(${lockKeyNum}::bigint) AS locked;
        `;

        const advisoryLocked = advisoryResult[0].locked;
        if (!advisoryLocked) {
          logger.info({
            message: `[${jobId}] Listing ${listingId} already has advisory lock`,
            jobId,
            listingId,
          });
          return false;
        }

        try {
          // Try to create database lock
          await this.prisma.$transaction(async (tx) => {
            // Double check within transaction that no lock was created
            const lockCheck = await tx.listingLock.findFirst({
              where: {
                listingId,
                expiresAt: {
                  gt: new Date(),
                },
              },
            });

            if (lockCheck) {
              throw new Error("Lock was acquired by another process");
            }

            await tx.listingLock.create({
              data: {
                listingId,
                jobId,
                processId: process.pid.toString(),
                expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
              },
            });
          });

          return true;
        } catch (dbError) {
          // If database lock fails, release advisory lock
          await this.prisma
            .$queryRaw`SELECT pg_advisory_unlock(${lockKeyNum}::bigint)`;

          if (
            dbError instanceof Prisma.PrismaClientKnownRequestError &&
            dbError.code === "P2002"
          ) {
            logger.info(`[${jobId}] Listing lock already exists in database`, {
              jobId,
              listingId,
            });
            return false;
          }

          throw dbError;
        }
      } catch (error) {
        retries++;
        logger.warn(
          `[${jobId}] Failed to acquire listing lock (attempt ${retries}/${maxRetries})`,
          {
            error: error instanceof Error ? error.message : "Unknown error",
            jobId,
            listingId,
          }
        );

        // Ensure advisory lock is released in case of any error
        try {
          await this.prisma
            .$queryRaw`SELECT pg_advisory_unlock(${lockKeyNum}::bigint)`;
        } catch (unlockError) {
          logger.error(
            `[${jobId}] Failed to release advisory lock after error`,
            {
              error:
                unlockError instanceof Error
                  ? unlockError.message
                  : "Unknown error",
              jobId,
              listingId,
            }
          );
        }

        if (retries < maxRetries) {
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

      // Acquire lock to prevent concurrent processing of the same listing
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

      // Process vision images with memory check
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
        // Process runway videos with memory check and retry with backoff
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
        // Check for existing videos
        const existingVideosData = await this.getRunwayVideos(jobId);
        const existingVideos = existingVideosData.map((v) => v.path);

        if (
          existingVideos.length === input.inputFiles.length &&
          !isRegeneration // Skip cache if regenerating
        ) {
          runwayVideos = existingVideos;
          logger.info(`[${jobId}] Using cached Runway videos`, {
            count: runwayVideos.length,
          });
        } else {
          // Process runway videos with memory check and retry with backoff
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

      // Validate video count and ensure no missing videos
      runwayVideos = this.validateVideoCount(
        runwayVideos,
        inputFiles.length,
        jobId,
        !!isRegeneration
      );

      logger.debug(`[${jobId}] Runway videos generated`, { runwayVideos });

      // Verify all resources are accessible before proceeding
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

      // If map video was generated, verify it's accessible
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
      // Release the lock if we acquired one
      if (!input.skipLock && input.listingId) {
        try {
          await this.releaseListingLock(jobId, input.listingId);
          logger.info(
            `[${jobId}] Lock released for listing ${input.listingId}`
          );
        } catch (lockError) {
          logger.warn(
            `[${jobId}] Failed to release lock for listing ${input.listingId}`,
            {
              error:
                lockError instanceof Error
                  ? lockError.message
                  : "Unknown error",
            }
          );
        }
      }

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

  /**
   * Validates a map video file for completeness and quality
   */
  private async validateMapVideo(
    videoPath: string,
    jobId: string
  ): Promise<boolean> {
    try {
      let localPath = videoPath;

      // If it's an S3 URL, download it temporarily for validation
      if (videoPath.startsWith("https://")) {
        localPath = path.join(
          process.cwd(),
          "temp",
          `${jobId}_map_validate.mp4`
        );
        await this.s3Service.downloadFile(videoPath, localPath);
        await this.resourceManager.trackResource(localPath);
      }

      // Check if file exists and is readable
      await fs.access(localPath, fs.constants.R_OK);

      // Check file size
      const stats = await fs.stat(localPath);
      if (stats.size < 1024) {
        // Minimum 1KB
        logger.warn(`[${jobId}] Map video file too small`, {
          size: stats.size,
          path: videoPath,
        });
        return false;
      }

      // Check video duration
      const duration = await videoProcessingService.getVideoDuration(localPath);
      if (duration < 1) {
        // Minimum 1 second
        logger.warn(`[${jobId}] Map video duration too short`, {
          duration,
          path: videoPath,
        });
        return false;
      }

      // Check video integrity
      const isIntegrityValid =
        await videoProcessingService.validateVideoIntegrity(localPath);
      if (!isIntegrityValid) {
        logger.warn(`[${jobId}] Map video integrity check failed`, {
          path: videoPath,
        });
        return false;
      }

      // Check video metadata
      const metadata = await videoProcessingService.getVideoMetadata(localPath);
      if (!metadata.hasVideo || !metadata.width || !metadata.height) {
        logger.warn(`[${jobId}] Map video missing required metadata`, {
          path: videoPath,
          metadata,
        });
        return false;
      }

      // Clean up temporary file if we downloaded it
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
      });
      return false;
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

    // Verify and log database updates for each generated video
    for (const result of results) {
      if (result?.path) {
        runwayVideos[result.index] = result.path;
        // Verify the runwayVideoPath is saved in the database
        const updatedPhoto = await this.prisma.photo.findFirst({
          where: {
            listingId,
            order: result.index,
            status: "COMPLETED",
          },
          select: { runwayVideoPath: true },
        });
        if (
          !updatedPhoto?.runwayVideoPath ||
          updatedPhoto.runwayVideoPath !== result.path.s3Url // Acceder a s3Url
        ) {
          logger.error(
            `[${jobId}] runwayVideoPath not saved correctly for order ${result.index}`,
            {
              expected: result.path.s3Url, // Usar s3Url aquí también
              actual: updatedPhoto?.runwayVideoPath,
            }
          );
          throw new Error(
            `Failed to save runwayVideoPath for order ${result.index}`
          );
        }
        logger.info(
          `[${jobId}] Successfully saved runwayVideoPath for order ${result.index}`,
          {
            path: result.path,
          }
        );
      } else {
        logger.warn(
          `[${jobId}] No runway video generated for order ${result.index}`,
          {
            inputFile: inputFiles[result.index],
          }
        );
      }
    }

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
}
