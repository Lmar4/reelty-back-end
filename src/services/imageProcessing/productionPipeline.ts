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
import {
  VideoTemplate,
  WatermarkConfig,
} from "../video/video-template.service";

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
          },
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

  private async processRunwayVideos(jobId: string): Promise<string[]> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        listingId: true,
        metadata: true,
      },
    });

    if (!job?.listingId) return [];

    const isRegeneration = (job.metadata as any)?.isRegeneration === true;
    const regenerationContext = (job.metadata as any)?.regenerationContext;

    if (isRegeneration && regenerationContext) {
      const { photosToRegenerate, existingPhotos, totalPhotos } =
        regenerationContext;
      const runwayVideos = new Array(totalPhotos).fill(null);

      // First, map all existing videos to their positions
      existingPhotos.forEach((photo: any) => {
        if (photo.runwayVideoPath && photo.order < totalPhotos) {
          runwayVideos[photo.order] = photo.runwayVideoPath;
          logger.info(`[${jobId}] Using existing runway video`, {
            order: photo.order,
            path: photo.runwayVideoPath,
          });
        }
      });

      // Then process photos that need regeneration
      for (const photo of photosToRegenerate) {
        const runwayVideo = await this.retryRunwayGeneration(
          photo.processedFilePath,
          photo.order,
          job.listingId,
          jobId
        );

        if (runwayVideo) {
          runwayVideos[photo.order] = runwayVideo;
          logger.info(`[${jobId}] Generated new runway video`, {
            order: photo.order,
            path: runwayVideo,
          });
        }
      }

      // Validate the array and ensure we have all videos
      const missingVideos = runwayVideos
        .map((v, i) => ({ video: v, index: i }))
        .filter(({ video }) => !video);

      if (missingVideos.length > 0) {
        logger.warn(`[${jobId}] Missing videos at positions:`, {
          missingPositions: missingVideos.map((m) => m.index),
          totalExpected: totalPhotos,
          found: totalPhotos - missingVideos.length,
        });

        // Try to recover missing videos from existingPhotos
        for (const { index } of missingVideos) {
          const existingPhoto = existingPhotos.find(
            (p: Photo) => p.order === index
          );
          if (existingPhoto?.runwayVideoPath) {
            runwayVideos[index] = existingPhoto.runwayVideoPath;
            logger.info(
              `[${jobId}] Recovered missing video from existing photos`,
              {
                order: index,
                path: existingPhoto.runwayVideoPath,
              }
            );
          }
        }
      }

      // Return all videos, maintaining order
      if (runwayVideos.some((v) => !v)) {
        logger.error(
          `[${jobId}] Still missing some videos after recovery attempt`,
          {
            missingPositions: runwayVideos
              .map((v, i) => (v ? null : i))
              .filter((i) => i !== null),
            totalVideos: runwayVideos.length,
            validVideos: runwayVideos.filter((v) => v).length,
          }
        );
      }

      // Return all valid videos while maintaining their order
      return runwayVideos.filter(
        (v): v is string => typeof v === "string" && v.length > 0
      );
    } else {
      const visionImages = await this.processVisionImages(jobId);
      const runwayVideos = new Array(visionImages.length).fill(null);

      for (let i = 0; i < visionImages.length; i += this.currentBatchSize) {
        const batch = visionImages.slice(
          i,
          Math.min(i + this.currentBatchSize, visionImages.length)
        );
        const progress = (i / visionImages.length) * 100;

        await this.updateJobProgress(jobId, {
          stage: "runway",
          progress,
          message: `Processing new videos ${i + 1}-${i + batch.length} of ${
            visionImages.length
          }`,
        });

        const results = await this.processWithMemoryCheck(
          jobId,
          async () => {
            return Promise.all(
              batch.map(async (image: ProcessingImage) => {
                const runwayVideo = await this.retryRunwayGeneration(
                  image.path,
                  image.order,
                  job.listingId,
                  jobId
                );
                return { order: image.order, path: runwayVideo };
              })
            );
          },
          "runway new processing"
        );

        results.forEach((result: { order: number; path: string | null }) => {
          if (result.path) {
            runwayVideos[result.order] = result.path;
          }
        });
      }

      const validVideos = runwayVideos.filter((v): v is string => !!v);
      logger.info(`[${jobId}] Completed runway video generation`, {
        processed: validVideos.length,
        expected: visionImages.length,
        listingId: job.listingId,
      });

      return validVideos;
    }
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
      return url.slice(5).split("/").slice(1).join("/");
    }
    try {
      const urlObj = new URL(url);
      return urlObj.pathname.slice(1); // Remove leading slash
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
    const tempDir = path.join(process.cwd(), "temp", jobId);

    try {
      await fs.mkdir(tempDir, { recursive: true });
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

      // Download watermark locally
      let watermarkConfig: WatermarkConfig | undefined;
      let localWatermarkPath: string | undefined;
      try {
        const watermarkAssetPath = await this.assetManager.getAssetPath(
          AssetType.WATERMARK,
          "reelty_watermark.png"
        );
        localWatermarkPath = path.join(tempDir, "reeltywatermark.png");
        await this.s3Service.downloadFile(
          watermarkAssetPath,
          localWatermarkPath
        );
        watermarkConfig = {
          path: localWatermarkPath,
          position: { x: "(main_w-overlay_w)/2", y: "main_h-overlay_h-180" },
        };
      } catch (error) {
        logger.warn(`[${jobId}] Failed to download watermark, skipping`, {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        watermarkConfig = undefined;
      }

      // Download videos locally
      const localVideos = await Promise.all(
        runwayVideos.map(async (video, index) => {
          const localPath = path.join(tempDir, `segment_${index}.mp4`);
          await this.s3Service.downloadFile(video, localPath);
          return localPath;
        })
      );

      // Handle map video
      let localMapVideo: string | undefined;
      if (templateConfig.sequence.includes("map") && mapVideo) {
        localMapVideo = path.join(tempDir, "map.mp4");
        await this.s3Service.downloadFile(mapVideo, localMapVideo);
      }

      // Create combined video array with map video
      const durations: number[] = Array.isArray(templateConfig.durations)
        ? templateConfig.durations
        : Object.values(templateConfig.durations);

      const combinedVideos: string[] = [];
      const adjustedDurations: number[] = [];

      templateConfig.sequence.forEach((item, index) => {
        if (item === "map" && localMapVideo) {
          combinedVideos.push(localMapVideo);
          adjustedDurations.push(
            typeof templateConfig.durations === "object"
              ? (templateConfig.durations as Record<string, number>).map
              : durations[index]
          );
        } else {
          const videoIndex = typeof item === "string" ? parseInt(item) : item;
          if (videoIndex < localVideos.length) {
            combinedVideos.push(localVideos[videoIndex]);
            adjustedDurations.push(durations[index]);
          }
        }
      });

      const clips = combinedVideos.map((path, index) => ({
        path,
        duration: adjustedDurations[index],
        transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
        colorCorrection: templateConfig.colorCorrection,
      }));

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
          music: templateConfig.music,
          outputOptions: ["-q:a 2"], // Ensure MP3 quality with libmp3lame
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
      // Cleanup temp directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`[${jobId}] Failed to cleanup temp directory`, {
          template,
          tempDir,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
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

    const results = await Promise.all(templatePromises);
    return results
      .filter((r) => r.status === "SUCCESS" && r.outputPath)
      .map((r) => r.outputPath!);
  }

  private async processVisionImages(jobId: string): Promise<ProcessingImage[]> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        listingId: true,
        metadata: true,
        inputFiles: true,
      },
    });

    if (!job?.listingId) return [];

    const isRegeneration = (job.metadata as any)?.isRegeneration === true;
    const regenerationContext = (job.metadata as any)?.regenerationContext;

    if (isRegeneration && regenerationContext) {
      const { photosToRegenerate } = regenerationContext;

      // Only process photos that need regeneration
      return photosToRegenerate.map((photo: Photo) => ({
        order: photo.order,
        path: photo.processedFilePath,
        id: photo.id,
      }));
    }

    // For non-regeneration case, process all input files
    return (job.inputFiles as string[]).map((path, index) => ({
      order: index,
      path,
    }));
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
      skipRunwayIfCached,
      skipLock,
    } = input;

    try {
      // Update job metadata with regeneration context if present
      if (isRegeneration && regenerationContext) {
        await this.prisma.videoJob.update({
          where: { id: jobId },
          data: {
            metadata: {
              isRegeneration,
              regenerationContext: JSON.parse(
                JSON.stringify(regenerationContext)
              ),
              skipRunwayIfCached,
              skipLock,
            } satisfies Prisma.InputJsonValue,
          },
        });
      }

      await this.updateJobProgress(jobId, {
        stage: "vision",
        progress: 0,
        message: "Starting pipeline",
      });

      // Process vision images
      await this.processVisionImages(jobId);

      // Check if we should skip Runway based on cache
      let runwayVideos: string[] = [];
      if (!skipRunwayIfCached) {
        runwayVideos = await this.processRunwayVideos(jobId);
      } else {
        // If skipping Runway, try to get cached videos first
        const existingVideos = await this.prisma.photo.findMany({
          where: {
            listingId: input.listingId,
            runwayVideoPath: { not: null },
          },
          orderBy: { order: "asc" },
          select: {
            runwayVideoPath: true,
            order: true,
          },
        });

        if (existingVideos.length === inputFiles.length) {
          runwayVideos = existingVideos.map((v) => v.runwayVideoPath!);
          logger.info(`[${jobId}] Using cached Runway videos`, {
            count: runwayVideos.length,
          });
        } else {
          // If we don't have all videos cached, process normally
          runwayVideos = await this.processRunwayVideos(jobId);
        }
      }

      // Generate map video if needed
      const mapVideo = coordinates
        ? await this.generateMapVideoForTemplate(
            coordinates,
            jobId,
            input.listingId
          )
        : null;

      // Process templates
      const templateResults = await this.processTemplatesForSpecific(
        runwayVideos,
        jobId,
        input.listingId,
        Object.keys(reelTemplates) as TemplateKey[],
        coordinates,
        mapVideo
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
          outputFile: templateResults[0],
          completedAt: new Date(),
          metadata: {
            defaultTemplate: template,
            processedTemplates: templateResults.map((path) => ({
              key: template,
              path,
            })),
            isRegeneration,
            regenerationContext: regenerationContext
              ? JSON.parse(JSON.stringify(regenerationContext))
              : null,
            skipRunwayIfCached,
            skipLock,
            runwayVideosCount: runwayVideos.length,
            hasMapVideo: !!mapVideo,
          } satisfies Prisma.InputJsonValue,
        },
      });

      return templateResults[0];
    } catch (error) {
      // Error handling remains the same
      logger.error(`[${jobId}] Pipeline execution failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        isRegeneration,
        skipRunwayIfCached,
        skipLock,
      });

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.FAILED,
          error: error instanceof Error ? error.message : "Unknown error",
          metadata: {
            errorDetails: {
              message: error instanceof Error ? error.message : "Unknown error",
              stack: error instanceof Error ? error.stack : undefined,
              timestamp: new Date().toISOString(),
            },
            isRegeneration,
            skipRunwayIfCached,
            skipLock,
          } satisfies Prisma.InputJsonValue,
        },
      });

      throw error;
    }
  }

  async execute(input: ProductionPipelineInput): Promise<string> {
    const { jobId, skipLock } = input;
    let lockAcquired = false;

    // First validate the job exists and has a valid listingId
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { listingId: true },
    });

    if (!job) {
      const error = `Job not found: ${jobId}`;
      logger.error(`[${jobId}] ${error}`);
      throw new Error(error);
    }

    if (!job.listingId) {
      const error = `Job ${jobId} has no associated listingId`;
      logger.error(`[${jobId}] ${error}`);
      throw new Error(error);
    }

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(job.listingId)) {
      const error = `Invalid UUID format for listingId: ${job.listingId}`;
      logger.error(`[${jobId}] ${error}`);
      throw new Error(error);
    }

    try {
      // Only acquire lock if skipLock is false
      if (!skipLock) {
        lockAcquired = await this.acquireListingLock(jobId, job.listingId);
        if (!lockAcquired) {
          const error = `Another job is already processing listing ${job.listingId}`;
          logger.warn(`[${jobId}] ${error}`);
          throw new Error(error);
        }
        logger.info(`[${jobId}] Acquired lock for listing`, {
          listingId: job.listingId,
          jobId,
        });
      } else {
        logger.warn(`[${jobId}] Skipping listing lock (testing mode)`, {
          listingId: job.listingId,
        });
      }

      // Start a transaction for the entire pipeline execution
      const result = await this.prisma.$transaction(
        async (tx) => {
          try {
            // Execute pipeline with validated listingId
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
            logger.error(`[${jobId}] Pipeline execution failed:`, {
              error: error instanceof Error ? error.message : "Unknown error",
              jobId,
              listingId: job.listingId,
              stack: error instanceof Error ? error.stack : undefined,
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
                  isRegeneration: input.isRegeneration,
                  skipRunwayIfCached: input.skipRunwayIfCached,
                  skipLock: input.skipLock,
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
      if (lockAcquired && !skipLock) {
        try {
          await this.releaseListingLock(jobId, job.listingId);
          logger.info(
            `[${jobId}] Released listing lock after successful execution`,
            {
              jobId,
              listingId: job.listingId,
            }
          );
        } catch (releaseError) {
          logger.error(`[${jobId}] Failed to release lock:`, {
            error:
              releaseError instanceof Error
                ? releaseError.message
                : "Unknown error",
            jobId,
            listingId: job.listingId,
          });
        }
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
        logger.error(`[${jobId}] Failed to update job status after error:`, {
          error:
            updateError instanceof Error
              ? updateError.message
              : "Unknown error",
          jobId,
          originalError:
            error instanceof Error ? error.message : "Unknown error",
          listingId: job.listingId,
        });
      }

      // Always attempt to release lock in case of error
      if (lockAcquired && !skipLock) {
        try {
          await this.releaseListingLock(jobId, job.listingId);
          logger.info(`[${jobId}] Released listing lock after error`, {
            jobId,
            listingId: job.listingId,
          });
        } catch (releaseError) {
          logger.error(`[${jobId}] Failed to release lock:`, {
            error:
              releaseError instanceof Error
                ? releaseError.message
                : "Unknown error",
            jobId,
            listingId: job.listingId,
          });
        }
      }

      throw error;
    } finally {
      // Only cleanup resources, don't release lock here
      await this.resourceManager.cleanup();
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
    const MAP_GENERATION_TIMEOUT = 120000; // 120 seconds timeout
    const cacheKey = `map_${jobId}_${crypto
      .createHash("md5")
      .update(`${coordinates.lat},${coordinates.lng}`)
      .digest("hex")}`;

    try {
      // Check cache first
      const cachedPath = await this.getCachedAsset(cacheKey, "map");
      if (cachedPath) {
        logger.info(`[${jobId}] Cache hit for map video`, {
          cacheKey,
          path: cachedPath,
        });

        // Verify cached video is still accessible
        try {
          const s3Key = this.getS3KeyFromUrl(cachedPath);
          const exists = await this.verifyS3Asset(s3Key);
          if (exists) {
            await resourceManager.trackResource(cachedPath, "map-video");
            return this.validateS3Url(cachedPath);
          }
          logger.warn(
            `[${jobId}] Cached map video not accessible, regenerating`,
            {
              path: cachedPath,
            }
          );
        } catch (error) {
          logger.warn(`[${jobId}] Error verifying cached map video`, {
            error: error instanceof Error ? error.message : "Unknown error",
            path: cachedPath,
          });
        }
      }

      logger.info(`[${jobId}] Starting map video generation`, {
        cacheKey,
        coordinates,
      });

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: "map",
        progress: 0,
        message: "Starting map video generation",
      });

      // Generate map video with retries and timeout
      const localVideoPath = await this.retryWithBackoff(
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
        2, // 2 retries (3 total attempts)
        "Map video generation",
        jobId
      );

      // Upload to temp S3 location first
      const s3TempKey = `temp/maps/${jobId}/${Date.now()}.mp4`;
      let tempS3Url: string | null = null;

      try {
        tempS3Url = await this.uploadToS3(localVideoPath, s3TempKey);
        await resourceManager.trackResource(tempS3Url, "map-video");
        logger.info(`[${jobId}] Uploaded map video to temp S3`, { tempS3Url });
      } catch (uploadError) {
        logger.warn(`[${jobId}] Failed to upload map video to temp location`, {
          error:
            uploadError instanceof Error
              ? uploadError.message
              : "Unknown error",
          localPath: localVideoPath,
          s3TempKey,
        });
        return null;
      }

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: "map",
        progress: 50,
        message: "Map video generated, moving to final location",
      });

      // Move to final location
      const desiredS3Key = `properties/${listingId}/videos/maps/${jobId}.mp4`;
      logger.info(`[${jobId}] Preparing to move map video`, {
        tempS3Key: s3TempKey,
        desiredS3Key,
      });

      try {
        await this.s3VideoService.moveFromTempToListing(
          s3TempKey,
          listingId,
          jobId
        );

        const finalS3Url = this.getS3UrlFromKey(desiredS3Key);

        // Verify the final video is accessible
        const exists = await this.verifyS3Asset(desiredS3Key);
        if (!exists) {
          logger.warn(
            `[${jobId}] Map video not accessible after move, using null`,
            {
              finalS3Url,
            }
          );
          return null;
        }

        // Cache the successful result
        await this.cacheAsset(cacheKey, finalS3Url, "map");

        logger.info(`[${jobId}] Map video moved to final location`, {
          finalS3Url,
        });

        await this.updateJobProgress(jobId, {
          stage: "template",
          subStage: "map",
          progress: 100,
          message: "Map video generation completed",
        });

        return finalS3Url;
      } catch (moveError) {
        logger.warn(`[${jobId}] Failed to move map video to final location`, {
          error:
            moveError instanceof Error ? moveError.message : "Unknown error",
          tempS3Key: s3TempKey,
          desiredS3Key,
        });

        // Try to use temp URL as fallback if move failed
        if (tempS3Url) {
          try {
            const tempExists = await this.verifyS3Asset(s3TempKey);
            if (tempExists) {
              logger.info(`[${jobId}] Using temp map video URL as fallback`, {
                tempS3Url,
              });
              return tempS3Url;
            }
          } catch (verifyError) {
            logger.warn(`[${jobId}] Failed to verify temp map video`, {
              error:
                verifyError instanceof Error
                  ? verifyError.message
                  : "Unknown error",
              tempS3Url,
            });
          }
        }
        return null;
      }
    } catch (error) {
      logger.warn(
        `[${jobId}] Map video generation failed, proceeding without`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          coordinates,
          stack: error instanceof Error ? error.stack : undefined,
        }
      );

      await this.updateJobProgress(jobId, {
        stage: "template",
        subStage: "map",
        progress: 0,
        error: error instanceof Error ? error.message : "Unknown error",
        message: "Map video generation failed, proceeding without",
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
}
