import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  AssetType,
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
import { logger } from "../../utils/logger";
import { streamToBuffer } from "../../utils/streamToBuffer";
import { AssetManager } from "../assets/asset-manager";
import { AssetCacheService } from "../cache/assetCache";
import { mapCaptureService } from "../map-capture/map-capture.service";
import { resourceManager, ResourceState } from "../storage/resource-manager";
import { S3Service } from "../storage/s3.service";
import { runwayService } from "../video/runway.service";
import { S3VideoService } from "../video/s3-video.service";
import { videoProcessingService } from "../video/video-processing.service";
import { reelTemplates, TemplateKey } from "./templates/types";
import { ImageOptimizationOptions, VisionProcessor } from "./visionProcessor";

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
}

interface RegenerationContext {
  photosToRegenerate: Array<{
    id: string;
    processedFilePath: string;
    order: number;
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

class ResourceManager {
  private tempFiles: Set<string> = new Set();

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
  private readonly MEMORY_WARNING_THRESHOLD = 0.8;
  private readonly MAX_RETRIES = 3;
  private readonly BATCH_SIZE = 3;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly TEMP_DIRS = { OUTPUT: "temp/output" };
  private readonly REQUIRED_VIDEO_COUNT = 10;
  private readonly MIN_REGENERATION_VIDEO_COUNT = 1;
  private readonly MAP_CACHE_DURATION = 24 * 60 * 60 * 1000;
  private readonly MAX_RUNWAY_RETRIES = 3;
  private readonly INITIAL_RETRY_DELAY = 1000;
  private readonly LOCK_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  private s3Client: S3Client;
  private resourceManager: ResourceManager;
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
    this.limit = pLimit(this.BATCH_SIZE);
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
    cacheKey: string,
    path: string,
    type: "runway" | "map" | "webp"
  ): Promise<void> {
    const fileBuffer = await fs.readFile(path);
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

      // Update resource state to uploaded
      await resourceManager.updateResourceState(
        inputUrl,
        ResourceState.UPLOADED,
        {
          s3Url,
        }
      );

      // Update the Photo record with the Runway video URL
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
        },
      });

      logger.info(`[${jobId}] Stored Runway video URL for photo`, {
        listingId,
        order: index,
        s3Url,
      });

      return s3Url;
    } catch (error) {
      const isLastAttempt = attempt >= this.MAX_RUNWAY_RETRIES;
      logger.error(
        `[${jobId}] Runway generation attempt ${attempt} failed${
          isLastAttempt ? " (final attempt)" : ""
        }`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          index,
          inputUrl,
        }
      );

      await resourceManager.updateResourceState(
        inputUrl,
        ResourceState.FAILED,
        {
          error: error instanceof Error ? error.message : "Unknown error",
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
    inputFiles: string[],
    jobId: string,
    listingId: string,
    isRegeneration?: boolean,
    regenerationContext?: RegenerationContext
  ): Promise<string[]> {
    this.monitorMemoryUsage(jobId);
    await this.updateJobProgress(jobId, {
      stage: "runway",
      progress: 0,
      message: "Processing with Runway",
    });

    // Fetch existing photos from DB
    const existingPhotos = await this.prisma.photo.findMany({
      where: { listingId, runwayVideoPath: { not: null }, status: "COMPLETED" },
      select: {
        id: true,
        order: true,
        runwayVideoPath: true,
        processedFilePath: true,
      },
    });

    // Verify existing videos are accessible
    const verifiedVideos = new Map<number, string>();
    for (const photo of existingPhotos) {
      if (photo.runwayVideoPath) {
        try {
          const s3Key = this.getS3KeyFromUrl(photo.runwayVideoPath);
          const exists = await this.verifyS3Asset(s3Key);
          if (exists) {
            verifiedVideos.set(photo.order, photo.runwayVideoPath);
            logger.info(`[${jobId}] Verified existing video`, {
              order: photo.order,
              path: photo.runwayVideoPath,
            });
          } else {
            logger.warn(
              `[${jobId}] Existing video not accessible, will regenerate`,
              {
                order: photo.order,
                path: photo.runwayVideoPath,
              }
            );
          }
        } catch (error) {
          logger.warn(`[${jobId}] Failed to verify video, will regenerate`, {
            order: photo.order,
            path: photo.runwayVideoPath,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    }

    logger.info(`[${jobId}] Found existing photos`, {
      count: existingPhotos.length,
      verified: verifiedVideos.size,
      photos: existingPhotos.map((p) => ({ id: p.id, order: p.order })),
    });

    const processVideo = async (
      file: string,
      index: number,
      forceRegenerate: boolean = false
    ): Promise<string> => {
      // Check verified cache first
      const existingVideo = verifiedVideos.get(index);
      if (existingVideo && !forceRegenerate) {
        logger.info(`[${jobId}] Reusing verified video`, {
          index,
          s3Url: existingVideo,
        });
        return existingVideo;
      }

      logger.info(`[${jobId}] Generating new video`, {
        index,
        forceRegenerate,
        hasExistingUrl: !!existingVideo,
      });

      const videoPath = await this.retryRunwayGeneration(
        file,
        index,
        listingId,
        jobId
      );
      if (!videoPath)
        throw new Error(`Failed to generate video for index ${index}`);

      // Verify the newly generated video
      try {
        const s3Key = this.getS3KeyFromUrl(videoPath);
        const exists = await this.verifyS3Asset(s3Key);
        if (!exists) {
          throw new Error(`Newly generated video not accessible: ${videoPath}`);
        }
      } catch (error) {
        logger.error(`[${jobId}] Failed to verify new video`, {
          index,
          path: videoPath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      }

      return videoPath;
    };

    let runwayVideos: string[];
    if (isRegeneration && regenerationContext) {
      const {
        photosToRegenerate,
        existingPhotos: contextExistingPhotos,
        totalPhotos,
      } = regenerationContext;
      runwayVideos = new Array(totalPhotos).fill(null);

      // First try to get videos from prior successful job
      const priorJob = await this.prisma.videoJob.findFirst({
        where: {
          listingId,
          status: "COMPLETED",
          id: { not: jobId },
        },
        orderBy: { completedAt: "desc" },
        select: { id: true, metadata: true },
      });

      let priorVideos: string[] = [];
      if (priorJob?.metadata) {
        const metadata = priorJob.metadata as any;
        priorVideos =
          metadata.processedTemplates
            ?.map((t: any) => t.path)
            .filter(Boolean) || [];
        logger.info(`[${jobId}] Found prior job videos`, {
          count: priorVideos.length,
          jobId: priorJob.id,
        });

        // Verify prior videos
        const verifiedPriorVideos = await Promise.all(
          priorVideos.map(async (path) => {
            try {
              const s3Key = this.getS3KeyFromUrl(path);
              const exists = await this.verifyS3Asset(s3Key);
              return exists ? path : null;
            } catch {
              return null;
            }
          })
        );
        priorVideos = verifiedPriorVideos.filter(
          (v): v is string => v !== null
        );
        logger.info(`[${jobId}] Verified prior videos`, {
          total: verifiedPriorVideos.length,
          valid: priorVideos.length,
        });
      }

      // Get all photos to ensure we have complete context
      const allPhotos = await this.prisma.photo.findMany({
        where: { listingId },
        select: { id: true, order: true, runwayVideoPath: true },
        orderBy: { order: "asc" },
      });

      // Pre-fill from verified videos first
      allPhotos.forEach((photo) => {
        const verifiedVideo = verifiedVideos.get(photo.order);
        if (verifiedVideo) {
          runwayVideos[photo.order] = verifiedVideo;
          logger.info(`[${jobId}] Pre-filled video from verified cache`, {
            id: photo.id,
            order: photo.order,
            url: verifiedVideo,
          });
        }
      });

      // Fill remaining gaps with prior job videos
      priorVideos.forEach((url, idx) => {
        if (idx < totalPhotos && !runwayVideos[idx]) {
          runwayVideos[idx] = url;
          logger.info(`[${jobId}] Pre-filled video from prior job`, {
            order: idx,
            url,
          });
        }
      });

      // Regenerate specified photos
      const regeneratePromises = photosToRegenerate.map(async (photo) => {
        logger.info(`[${jobId}] Regenerating video`, {
          id: photo.id,
          order: photo.order,
          hasExistingUrl: verifiedVideos.has(photo.order),
        });
        const result = await processVideo(
          photo.processedFilePath,
          photo.order,
          true
        );
        return { order: photo.order, path: result };
      });

      const results = await Promise.all(regeneratePromises);
      results.forEach(({ order, path }) => {
        runwayVideos[order] = path;
        logger.info(`[${jobId}] Updated video at position`, { order, path });
      });

      // Fill any remaining gaps with processed images
      inputFiles.forEach((file, idx) => {
        if (idx < totalPhotos && !runwayVideos[idx]) {
          runwayVideos[idx] = verifiedVideos.get(idx) || file;
          logger.warn(`[${jobId}] Filled missing video slot with fallback`, {
            order: idx,
            url: runwayVideos[idx],
          });
        }
      });

      const validVideos = runwayVideos.filter((v): v is string => !!v);
      logger.info(`[${jobId}] Final video count for regeneration`, {
        valid: validVideos.length,
        expected: totalPhotos,
        fromVerified: verifiedVideos.size,
        fromPrior: priorVideos.length,
        regenerated: results.length,
      });
      this.validateVideoCount(
        validVideos,
        totalPhotos,
        jobId,
        true,
        priorVideos,
        results.map((r) => r.path)
      );
      return validVideos;
    } else {
      // Normal processing
      runwayVideos = await Promise.all(
        inputFiles.map((file, index) => processVideo(file, index, false))
      );
      const validVideos = runwayVideos.filter((v): v is string => !!v);
      this.validateVideoCount(
        validVideos,
        Math.min(inputFiles.length, 10),
        jobId,
        false,
        [],
        []
      );
      return validVideos.slice(0, 10); // Cap at 10 videos
    }
  }

  private getS3KeyFromUrl(url: string): string {
    if (url.startsWith("s3://")) {
      return url.slice(5);
    }
    const urlParts = new URL(url);
    return urlParts.pathname.slice(1); // Remove leading slash
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
    const s3Key = path.split("/").slice(3).join("/"); // Extract S3 key from URL
    const MAX_TIMEOUT = 30000; // 30 seconds total timeout
    const startTime = Date.now();

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
      totalTime: Date.now() - startTime,
    });
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

    try {
      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: template,
        progress: 0,
        message: `Generating ${template} template`,
      });

      const templateConfig = reelTemplates[template];
      if (!templateConfig) {
        throw new Error(`Unknown template: ${template}`);
      }

      // Validate all input videos are accessible
      logger.info(`[${jobId}] Validating input videos`, {
        template,
        videoCount: runwayVideos.length,
      });

      const validationResults = await Promise.all(
        runwayVideos.map(async (video, index) => {
          try {
            const validatedUrl = await this.verifyS3VideoAccess(video, jobId);
            if (!validatedUrl) {
              throw new Error(`Video not accessible: ${video}`);
            }
            return { url: validatedUrl, index };
          } catch (error) {
            logger.error(`[${jobId}] Video validation failed`, {
              video,
              index,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return { url: null, index };
          }
        })
      );

      const invalidVideos = validationResults.filter((r) => !r.url);
      if (invalidVideos.length > 0) {
        throw new Error(
          `Some videos are not accessible: indices ${invalidVideos
            .map((v) => v.index)
            .join(", ")}`
        );
      }

      // Replace with validated URLs
      const validatedVideos = validationResults.map((r) => r.url!);

      // Durations is the authority - extract as array
      const durations: number[] = Array.isArray(templateConfig.durations)
        ? templateConfig.durations
        : Object.values(templateConfig.durations);
      const requiredVideos = durations.length;

      logger.info(`[${jobId}] Template configuration`, {
        template,
        requiredVideos,
        availableVideos: validatedVideos.length,
        durations: durations.length,
        hasMapVideo: !!mapVideo,
      });

      // First ensure we have at least one video
      if (validatedVideos.length === 0) {
        throw new Error("No valid input videos provided");
      }

      // Handle map video requirement
      const hasMapRequirement = templateConfig.sequence.includes("map");
      if (hasMapRequirement) {
        if (!mapVideo) {
          throw new Error("Map video required but not provided");
        }
        // Validate map video
        const validatedMapUrl = await this.verifyS3VideoAccess(mapVideo, jobId);
        if (!validatedMapUrl) {
          throw new Error("Map video not accessible");
        }
        mapVideo = validatedMapUrl;
      }

      // Create combined video array with map video in correct position
      let combinedVideos: string[] = [];
      let adjustedDurations: number[] = [];

      templateConfig.sequence.forEach((item, index) => {
        if (item === "map") {
          combinedVideos.push(mapVideo!);
          adjustedDurations.push(
            typeof templateConfig.durations === "object"
              ? (templateConfig.durations as Record<string, number>).map
              : durations[index]
          );
        } else {
          const videoIndex = typeof item === "string" ? parseInt(item) : item;
          if (videoIndex < validatedVideos.length) {
            combinedVideos.push(validatedVideos[videoIndex]);
            adjustedDurations.push(durations[index]);
          }
        }
      });

      logger.info(`[${jobId}] Combined videos for template`, {
        template,
        totalVideos: combinedVideos.length,
        expectedVideos: templateConfig.sequence.length,
        adjustedDurations: adjustedDurations.length,
      });

      // Create clips with adjusted videos and durations
      const clips = combinedVideos.map((path, index) => ({
        path,
        duration: adjustedDurations[index],
        transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
        colorCorrection: templateConfig.colorCorrection,
      }));

      const outputPath = path.join(
        process.cwd(),
        this.TEMP_DIRS.OUTPUT,
        `${template}_${Date.now()}_output.mp4`
      );

      await videoProcessingService.stitchVideos(
        clips,
        outputPath,
        templateConfig,
        {
          path: await this.assetManager.getAssetPath(
            AssetType.WATERMARK,
            "reelty_watermark.png"
          ),
          position: { x: "(main_w-overlay_w)/2", y: "main_h-overlay_h-20" },
        }
      );

      const s3Key = `properties/${listingId}/videos/templates/${jobId}/${template}.mp4`;
      const s3Url = await this.uploadToS3(outputPath, s3Key);

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: template,
        progress: 100,
        message: `${template} template completed`,
      });

      return {
        template,
        status: "SUCCESS",
        outputPath: s3Url,
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
    }
  }

  private async processTemplatesForSpecific(
    runwayVideos: string[],
    jobId: string,
    listingId: string,
    templates: TemplateKey[],
    coordinates?: { lat: number; lng: number }
  ): Promise<string[]> {
    const mapVideo = coordinates
      ? await this.generateMapVideoForTemplate(coordinates, jobId, listingId)
      : null;

    const templatePromises = templates.map((template) =>
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

    const results = await Promise.all(templatePromises);
    return results
      .filter((r) => r.status === "SUCCESS" && r.outputPath)
      .map((r) => r.outputPath!);
  }

  private async processVisionImages(
    inputFiles: string[],
    jobId: string,
    listingId: string,
    isRegeneration?: boolean,
    regenerationContext?: RegenerationContext
  ): Promise<string[]> {
    this.monitorMemoryUsage(jobId);

    const processImage = async (
      file: string,
      index: number
    ): Promise<string> => {
      const s3Key = `properties/${listingId}/images/processed/${jobId}/vision_${index}.webp`;
      const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";

      return await this.withRetry(async () => {
        try {
          // Track resource processing
          await resourceManager.trackResource(file, "vision-input");
          await resourceManager.updateResourceState(
            file,
            ResourceState.PROCESSING
          );

          // Get crop coordinates by downloading the file once
          const { Body } = await this.s3Client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: file.startsWith("https://")
                ? file.split("/").slice(3).join("/")
                : file,
            })
          );

          if (!Body) {
            throw new Error(`No body in S3 response for file: ${file}`);
          }

          const inputBuffer = await streamToBuffer(Body as Readable);
          const cropCoords = await this.visionProcessor.analyzeImageForCrop(
            inputBuffer
          );

          // Process image with Sharp and stream directly to S3
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

          // Upload processed image to S3 with retries
          const upload = new Upload({
            client: this.s3Client,
            params: {
              Bucket: bucket,
              Key: s3Key,
              Body: sharpStream,
              ContentType: "image/webp",
            },
          });

          await upload.done();
          const s3Url = `https://${bucket}.s3.${
            process.env.AWS_REGION || "us-east-2"
          }.amazonaws.com/${s3Key}`;

          // Verify the upload was successful
          const exists = await this.verifyS3Asset(s3Key);
          if (!exists) {
            throw new Error(`Uploaded image not accessible at ${s3Url}`);
          }

          // Update resource state and Photo record
          await resourceManager.updateResourceState(
            file,
            ResourceState.UPLOADED,
            {
              s3Url,
            }
          );

          // Update Photo record within the same transaction
          await this.prisma.photo.updateMany({
            where: {
              listingId,
              order: index,
              status: { in: ["PENDING", "PROCESSING"] },
            },
            data: {
              processedFilePath: s3Url,
              status: "COMPLETED",
              updatedAt: new Date(),
            },
          });

          return s3Url;
        } catch (error) {
          await resourceManager.updateResourceState(
            file,
            ResourceState.FAILED,
            {
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
          throw error;
        }
      });
    };

    try {
      let processedImages: string[];

      if (isRegeneration && regenerationContext) {
        const { photosToRegenerate, existingPhotos, totalPhotos } =
          regenerationContext;
        processedImages = new Array(totalPhotos).fill(null);

        // First, fill in existing photos that don't need regeneration
        existingPhotos.forEach((photo) => {
          processedImages[photo.order] = photo.processedFilePath;
          logger.info(`[${jobId}] Reusing existing processed file`, {
            order: photo.order,
            path: photo.processedFilePath,
          });
        });

        // Then, only process photos that need regeneration
        const regenerationResults = await Promise.all(
          photosToRegenerate.map((p) =>
            processImage(p.processedFilePath, p.order).then((path) => ({
              order: p.order,
              path,
            }))
          )
        );

        regenerationResults.forEach(({ order, path }) => {
          processedImages[order] = path;
          logger.info(`[${jobId}] Regenerated processed file`, {
            order,
            path,
          });
        });

        // Validate all slots are filled
        const validImages = processedImages.filter((v): v is string => !!v);
        if (validImages.length !== totalPhotos) {
          throw new Error(
            `Missing processed images: expected ${totalPhotos}, got ${validImages.length}`
          );
        }
      } else {
        processedImages = await Promise.all(
          inputFiles.map((file, index) =>
            this.limit(() => processImage(file, index))
          )
        );
      }

      const validImages = processedImages.filter((v): v is string => !!v);
      if (validImages.length === 0) {
        throw new Error("No images processed by VisionProcessor");
      }

      await this.updateJobProgress(jobId, {
        stage: "vision",
        progress: 100,
        message: "Vision processing completed",
      });

      return validImages;
    } catch (error) {
      logger.error("Vision processing failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        jobId,
        listingId,
      });
      throw error;
    }
  }

  private async acquireListingLock(
    jobId: string,
    listingId: string
  ): Promise<boolean> {
    try {
      // Take first 8 characters of hex (32 bits) to ensure it fits in bigint
      const lockKeyHex = crypto
        .createHash("sha256")
        .update(listingId)
        .digest("hex")
        .slice(0, 8);
      // Ensure positive number within safe range
      const lockKeyNum = Math.abs(parseInt(lockKeyHex, 16)) % 2 ** 31;

      const result = await this.prisma.$queryRaw<{ locked: boolean }[]>`
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

      logger.info({
        message: `[${jobId}] Acquired advisory lock for ${listingId}`,
        lockKey: lockKeyNum.toString(),
        jobId,
        listingId,
      });
      return true;
    } catch (error) {
      logger.error({
        message: `[${jobId}] Failed to acquire advisory lock`,
        error: error instanceof Error ? error.message : "Unknown error",
        jobId,
        listingId,
      });
      return false;
    }
  }

  private async releaseListingLock(
    jobId: string,
    listingId: string
  ): Promise<void> {
    try {
      // Use same logic as acquireListingLock to generate consistent lock key
      const lockKeyHex = crypto
        .createHash("sha256")
        .update(listingId)
        .digest("hex")
        .slice(0, 8);
      const lockKeyNum = Math.abs(parseInt(lockKeyHex, 16)) % 2 ** 31;

      await this.prisma.$queryRaw`
        SELECT pg_advisory_unlock(${lockKeyNum}::bigint);
      `;

      logger.info({
        message: `[${jobId}] Released advisory lock`,
        lockKey: lockKeyNum.toString(),
        jobId,
        listingId,
      });
    } catch (error) {
      logger.error({
        message: `[${jobId}] Failed to release advisory lock`,
        error: error instanceof Error ? error.message : "Unknown error",
        jobId,
        listingId,
      });
    }
  }

  private async executePipeline(
    input: ProductionPipelineInput & { listingId: string }
  ): Promise<string> {
    const {
      jobId,
      inputFiles,
      template,
      coordinates,
      isRegeneration,
      regenerationContext,
      skipRunway,
      skipRunwayIfCached,
    } = input;

    try {
      await this.updateJobProgress(jobId, {
        stage: "vision",
        progress: 0,
        message: "Starting pipeline",
      });

      // Process images with VisionProcessor first
      const processedImages = await this.processVisionImages(
        inputFiles,
        jobId,
        input.listingId,
        isRegeneration,
        regenerationContext
      );

      // Check if we can skip Runway based on cache
      const allCached =
        skipRunwayIfCached &&
        (await Promise.all(
          processedImages.map(async (file, index) => {
            const cacheKey = `runway_${jobId}_${index}_${crypto
              .createHash("md5")
              .update(file)
              .digest("hex")}`;
            return !!(await this.getCachedAsset(cacheKey, "runway"));
          })
        ).then((results) => results.every(Boolean)));

      // Get prior job videos if regenerating
      let priorJobVideos: string[] = [];
      if (isRegeneration) {
        const priorJob = await this.prisma.videoJob.findFirst({
          where: {
            listingId: input.listingId,
            status: "COMPLETED",
            id: { not: jobId }, // Exclude current job
          },
          orderBy: { completedAt: "desc" },
          select: {
            id: true,
            metadata: true,
          },
        });

        if (priorJob?.metadata) {
          const metadata = priorJob.metadata as any;
          priorJobVideos =
            metadata.processedTemplates
              ?.map((t: any) => t.path)
              .filter(Boolean) || [];
          logger.info(`[${jobId}] Found prior job videos`, {
            count: priorJobVideos.length,
            jobId: priorJob.id,
          });
        }
      }

      // Generate Runway videos using processed images
      let runwayVideos: string[] = processedImages;
      if (!skipRunway && !allCached) {
        runwayVideos = await this.processRunwayVideos(
          processedImages,
          jobId,
          input.listingId,
          isRegeneration,
          regenerationContext
        );
      } else if (allCached) {
        const cachedVideos = await Promise.all(
          processedImages.map(async (file, index) => {
            const cacheKey = `runway_${jobId}_${index}_${crypto
              .createHash("md5")
              .update(file)
              .digest("hex")}`;
            return await this.getCachedAsset(cacheKey, "runway");
          })
        );
        runwayVideos = cachedVideos.filter((v): v is string => v !== null);
        logger.info(`[${jobId}] Using cached Runway videos`, {
          count: runwayVideos.length,
        });
      }

      await this.updateJobProgress(jobId, {
        stage: "template",
        progress: 50,
        message: "Processing templates",
      });

      // Determine templates to process
      const templatesToProcess =
        isRegeneration || input.allTemplates ? ALL_TEMPLATES : [template];
      logger.info(`[${jobId}] Processing templates`, {
        count: templatesToProcess.length,
        templates: templatesToProcess,
        isRegeneration,
        allTemplates: input.allTemplates,
      });

      const templateResults = await this.processTemplatesForSpecific(
        runwayVideos,
        jobId,
        input.listingId,
        templatesToProcess,
        coordinates
      );

      if (templateResults.length === 0) {
        throw new Error("No templates processed successfully");
      }

      // Update job with results
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.COMPLETED,
          progress: 100,
          outputFile: templateResults[0], // Default output
          inputFiles,
          completedAt: new Date(),
          metadata: {
            defaultTemplate: template,
            processedTemplates: templateResults.map((path, idx) => ({
              key: templatesToProcess[idx],
              path,
            })),
            priorJobVideos:
              priorJobVideos.length > 0 ? priorJobVideos : undefined,
          } satisfies Prisma.InputJsonValue,
        },
      });

      return templateResults[0];
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.FAILED,
          progress: 0,
          error: errorMessage,
          metadata: {
            errorDetails: {
              message: errorMessage,
              stack: error instanceof Error ? error.stack : undefined,
              timestamp: new Date().toISOString(),
            },
          } satisfies Prisma.InputJsonValue,
        },
      });
      throw error;
    }
  }

  async execute(input: ProductionPipelineInput): Promise<string> {
    const { jobId } = input;
    let lockAcquired = false;

    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { listingId: true },
    });

    if (!job?.listingId) {
      throw new Error("Job or listingId not found");
    }

    try {
      // Acquire lock
      lockAcquired = await this.acquireListingLock(jobId, job.listingId);
      if (!lockAcquired) {
        throw new Error(
          `Another job is already processing listing ${job.listingId}`
        );
      }

      // Start a transaction for the entire pipeline execution
      const result = await this.prisma.$transaction(
        async (tx) => {
          try {
            // Execute pipeline
            const outputUrl = await this.executePipeline({
              ...input,
              listingId: job.listingId,
            });

            // Update job status within transaction
            await tx.videoJob.update({
              where: { id: jobId },
              data: {
                status: VideoGenerationStatus.COMPLETED,
                progress: 100,
                outputFile: outputUrl,
                completedAt: new Date(),
              },
            });

            return outputUrl;
          } catch (error) {
            // Log error and update job status within transaction
            logger.error("Pipeline execution failed:", {
              error: error instanceof Error ? error.message : "Unknown error",
              jobId,
              listingId: job.listingId,
            });

            await tx.videoJob.update({
              where: { id: jobId },
              data: {
                status: VideoGenerationStatus.FAILED,
                error: error instanceof Error ? error.message : "Unknown error",
                metadata: {
                  errorDetails: {
                    message:
                      error instanceof Error ? error.message : "Unknown error",
                    stack: error instanceof Error ? error.stack : undefined,
                    timestamp: new Date().toISOString(),
                  },
                } satisfies Prisma.InputJsonValue,
              },
            });

            // Extend lock timeout in case of failure to prevent other jobs from starting
            await tx.listingLock.update({
              where: { listingId: job.listingId },
              data: {
                expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT * 2), // Double the timeout
              },
            });

            throw error;
          }
        },
        {
          maxWait: 30000, // 30 seconds max wait for transaction
          timeout: this.LOCK_TIMEOUT, // Use same timeout as lock
        }
      );

      // Release lock only after successful transaction
      if (lockAcquired) {
        await this.releaseListingLock(jobId, job.listingId);
        logger.info("Released listing lock after successful execution", {
          jobId,
          listingId: job.listingId,
        });
      }

      return result;
    } catch (error) {
      // If transaction failed, ensure job is marked as failed
      try {
        await this.prisma.videoJob.update({
          where: { id: jobId },
          data: {
            status: VideoGenerationStatus.FAILED,
            error: error instanceof Error ? error.message : "Unknown error",
          },
        });
      } catch (updateError) {
        logger.error("Failed to update job status after error:", {
          error:
            updateError instanceof Error
              ? updateError.message
              : "Unknown error",
          jobId,
          originalError: error,
        });
      }
      throw error;
    } finally {
      // Only cleanup resources, don't release lock here
      await this.resourceManager.cleanup();
    }
  }

  private monitorMemoryUsage(jobId: string): void {
    const used = process.memoryUsage();
    if (used.heapUsed / used.heapTotal > this.MEMORY_WARNING_THRESHOLD) {
      logger.warn(`[${jobId}] High memory usage`, {
        heapUsed: (used.heapUsed / 1024 / 1024).toFixed(2) + " MB",
        heapTotal: (used.heapTotal / 1024 / 1024).toFixed(2) + " MB",
      });
    }
  }

  private async generateMapVideoForTemplate(
    coordinates: { lat: number; lng: number },
    jobId: string,
    listingId: string
  ): Promise<string | null> {
    const cacheKey = `map_${jobId}_${crypto
      .createHash("md5")
      .update(`${coordinates.lat},${coordinates.lng}`)
      .digest("hex")}`;
    const cachedPath = await this.getCachedAsset(cacheKey, "map");
    if (cachedPath) {
      logger.info(`[${jobId}] Cache hit for map video`, {
        cacheKey,
        path: cachedPath,
      });
      this.resourceManager.trackResource(cachedPath);
      return cachedPath;
    }

    const mapVideo = await mapCaptureService.generateMapVideo(
      coordinates,
      jobId
    );
    if (mapVideo) {
      const s3Key = `properties/${listingId}/videos/maps/${jobId}.mp4`;
      const s3Url = await this.uploadToS3(mapVideo, s3Key);
      this.resourceManager.trackResource(mapVideo);
      await this.cacheAsset(cacheKey, mapVideo, "map");
      return s3Url;
    }
    return null;
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
}
