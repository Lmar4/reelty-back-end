import {
  Listing,
  Prisma,
  PrismaClient,
  User,
  VideoGenerationStatus,
  VideoJob,
} from "@prisma/client";
import fs from "fs/promises";
import { logger } from "../../utils/logger";
import { mapCaptureService } from "../map-capture/map-capture.service";
import { runwayService } from "../video/runway.service";
import { videoTemplateService } from "../video/video-template.service";
import { reelTemplates, TemplateKey } from "./templates/types";
import { videoProcessingService } from "../video/video-processing.service";
import path from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { cleanupService } from "../cleanup/cleanup.service";

export interface VideoClip {
  path: string;
  duration: number;
}

interface ProductionPipelineInput {
  jobId: string;
  inputFiles: string[];
  template: (typeof ALL_TEMPLATES)[number];
  coordinates?: { lat: number; lng: number };
  _isRegeneration?: boolean;
  _regenerationContext?: RegenerationContext;
  _skipRunway?: boolean;
}

type VideoJobWithRelations = VideoJob & {
  listing?:
    | (Listing & {
        user?: User;
      })
    | null;
};

const ALL_TEMPLATES: TemplateKey[] = [
  "crescendo",
  "wave", 
  "storyteller",
  "googlezoomintro",
  "wesanderson",
  "hyperpop"
] as const;

// Ensure ALL_TEMPLATES includes all required templates
const REQUIRED_TEMPLATES = ALL_TEMPLATES;

// Type assertion to ensure ALL_TEMPLATES includes all TemplateKey values
type ValidateTemplates = (typeof ALL_TEMPLATES)[number] extends TemplateKey
  ? TemplateKey extends (typeof ALL_TEMPLATES)[number]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
type _TypeCheck = Assert<ValidateTemplates>;

interface ProgressStep {
  stage: "runway" | "template" | "upload";
  subStage?: string;
  progress: number;
  totalSteps: number;
  currentStep: number;
}

interface TemplateRequirements {
  minVideos: number;
  maxVideos: number;
  requiresCoordinates: boolean;
  supportedFormats: string[];
  sequence?: string[];
}

interface CacheConfig {
  expirationHours: number;
  usageThreshold: number;
}

const CACHE_TIERS: Record<string, CacheConfig> = {
  FREQUENT: {
    expirationHours: 7 * 24, // 7 days
    usageThreshold: 5, // Used more than 5 times
  },
  NORMAL: {
    expirationHours: 24, // 24 hours
    usageThreshold: 0,
  },
};

const TEMPLATE_CONFIGS: Record<TemplateKey, TemplateRequirements> =
  Object.fromEntries(
    Object.keys(reelTemplates).map((key) => [
      key,
      {
        minVideos: 1,
        maxVideos: 10,
        requiresCoordinates: key === "googlezoomintro",
        supportedFormats: ["mp4", "mov"],
        sequence: key === "crescendo" ? ["map"] : undefined,
      },
    ])
  ) as Record<TemplateKey, TemplateRequirements>;

class ResourceManager {
  private tempFiles: string[] = [];

  async trackResource(path: string) {
    this.tempFiles.push(path);
  }

  async cleanup() {
    await Promise.all(
      this.tempFiles.map(async (file) => {
        try {
          await fs.unlink(file);
        } catch (error) {
          logger.warn(`Failed to cleanup ${file}:`, error);
        }
      })
    );
    this.tempFiles = [];
  }
}

interface BatchProgressUpdate {
  stepsCompleted: string[];
  overallProgress: number;
  currentStage: ProgressStep["stage"];
  currentSubStage?: string;
}

interface AssetMetadata {
  template: TemplateKey;
  coordinates?: { lat: number; lng: number };
  timestamp: number;
  version: string;
  lastAccessed?: string; // ISO string date
  accessCount?: number;
  [key: string]: any; // Allow additional string-indexed properties
}

interface RunwayProcessingResult {
  paths: string[];
  timestamp: number;
}

interface TemplateProcessingResult {
  template: TemplateKey;
  status: "SUCCESS" | "FAILED";
  outputPath: string | null;
  error?: string;
  timestamp: number;
  processingTime?: number;
}

interface TemplateProcessingOptions {
  jobId: string;
  coordinates?: { lat: number; lng: number };
  cacheEnabled?: boolean;
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
  }>;
  regeneratedPhotoIds: string[];
  totalPhotos: number;
}

interface JobProgress {
  stage: "runway" | "template" | "upload";
  subStage?: string;
  progress: number;
  message?: string;
  error?: string;
  currentFile?: number;
  totalFiles?: number;
}

interface TemplateOutput {
  template: TemplateKey;
  path: string;
  success: boolean;
  error?: string;
}

export class ProductionPipeline {
  private readonly MEMORY_WARNING_THRESHOLD = 0.8;
  private readonly MAX_RETRIES = 3;
  private readonly BATCH_SIZE = 3; // Number of templates to process in parallel
  private readonly TEMP_DIRS = {
    MAP_CACHE: "temp/map-cache",
    OUTPUT: "temp/output",
    RUNWAY: "temp/runway",
  };
  private readonly PROGRESS_BATCH_SIZE = 5;

  private s3Client: S3Client;
  private batchedUpdates: BatchProgressUpdate = {
    stepsCompleted: [],
    overallProgress: 0,
    currentStage: "runway",
  };
  private runwayCache: Map<string, RunwayProcessingResult> = new Map();
  private progressUpdateQueue: Map<string, JobProgress[]> = new Map();

  constructor(
    private readonly prisma: PrismaClient = new PrismaClient(),
    private readonly resourceManager = new ResourceManager()
  ) {
    this.initializeTempDirectories();
    
    // Initialize cleanup service
    cleanupService.initialize().catch(error => {
      logger.error("Failed to initialize cleanup service:", error);
    });

    // Check for required AWS environment variables
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "Missing required AWS environment variables. Please check AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are set."
      );
    }

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  private async initializeTempDirectories() {
    try {
      // Ensure all temp directories exist
      await Promise.all(
        Object.values(this.TEMP_DIRS).map(async (dir) => {
          const fullPath = path.join(process.cwd(), dir);
          await fs.mkdir(fullPath, { recursive: true });
          logger.info(`Initialized temp directory: ${fullPath}`);
        })
      );
    } catch (error) {
      logger.error("Failed to initialize temp directories:", error);
      throw error;
    }
  }

  private getTempPath(
    type: keyof typeof this.TEMP_DIRS,
    filename: string
  ): string {
    return path.join(process.cwd(), this.TEMP_DIRS[type], filename);
  }

  private monitorMemoryUsage(jobId: string): void {
    const used = process.memoryUsage();
    if (used.heapUsed / used.heapTotal > this.MEMORY_WARNING_THRESHOLD) {
      logger.warn(`[${jobId}] High memory usage detected`, {
        heapUsed: (used.heapUsed / 1024 / 1024).toFixed(2) + " MB",
        heapTotal: (used.heapTotal / 1024 / 1024).toFixed(2) + " MB",
      });
    }
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

  private async flushProgressUpdates(jobId: string): Promise<void> {
    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status: VideoGenerationStatus.PROCESSING,
        progress: this.batchedUpdates.overallProgress,
        metadata: {
          stepsCompleted: this.batchedUpdates.stepsCompleted,
          currentStage: this.batchedUpdates.currentStage,
          currentSubStage: this.batchedUpdates.currentSubStage,
        },
      },
    });

    // Reset batched updates
    this.batchedUpdates = {
      stepsCompleted: [],
      overallProgress: this.batchedUpdates.overallProgress,
      currentStage: this.batchedUpdates.currentStage,
    };
  }

  private async updateDetailedProgress(
    jobId: string,
    progress: ProgressStep
  ): Promise<void> {
    // Update the batch instead of making immediate database call
    this.batchedUpdates.overallProgress =
      (progress.currentStep / progress.totalSteps) * 100;
    this.batchedUpdates.currentStage = progress.stage;
    this.batchedUpdates.currentSubStage = progress.subStage;
    this.batchedUpdates.stepsCompleted.push(
      `${progress.stage}${progress.subStage ? `:${progress.subStage}` : ""}`
    );

    // Only flush updates every 5 steps or when progress reaches 100%
    if (
      this.batchedUpdates.stepsCompleted.length >= 5 ||
      progress.currentStep === progress.totalSteps
    ) {
      await this.flushProgressUpdates(jobId);
    }
  }

  private generateCacheKey(input: {
    template?: TemplateKey;
    type?: string;
    inputFiles?: string[];
    coordinates?: { lat: number; lng: number };
    metadata?: Record<string, unknown>;
  }): string {
    const hash = require("crypto")
      .createHash("md5")
      .update(JSON.stringify(input))
      .digest("hex");
    return `${input.template || input.type}_${hash}`;
  }

  private async getCacheExpiration(cacheKey: string): Promise<CacheConfig> {
    // Get usage count from the last 7 days
    const usageCount = await this.prisma.processedAsset.count({
      where: {
        cacheKey,
        createdAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });

    return usageCount >= CACHE_TIERS.FREQUENT.usageThreshold
      ? CACHE_TIERS.FREQUENT
      : CACHE_TIERS.NORMAL;
  }

  private async getCachedAsset(
    cacheKey: string
  ): Promise<{ path: string } | null> {
    const cacheConfig = await this.getCacheExpiration(cacheKey);

    const cached = await this.prisma.processedAsset.findFirst({
      where: {
        cacheKey,
        createdAt: {
          gt: new Date(
            Date.now() - cacheConfig.expirationHours * 60 * 60 * 1000
          ),
        },
      },
    });

    if (
      cached &&
      typeof cached.metadata === "object" &&
      cached.metadata !== null
    ) {
      const currentMetadata = cached.metadata as unknown as AssetMetadata;
      // Update usage statistics
      await this.prisma.processedAsset.update({
        where: { id: cached.id },
        data: {
          metadata: {
            ...currentMetadata,
            lastAccessed: new Date().toISOString(), // Convert Date to string for JSON
            accessCount: (currentMetadata.accessCount || 0) + 1,
          } satisfies Prisma.InputJsonValue,
        },
      });
    }

    return cached ? { path: cached.path } : null;
  }

  private async cacheAsset(
    cacheKey: string,
    path: string,
    metadata: Omit<AssetMetadata, "lastAccessed" | "accessCount">
  ): Promise<void> {
    const hash = require("crypto").createHash("md5").update(path).digest("hex");

    // Ensure all required properties are included
    const fullMetadata: AssetMetadata = {
      template: metadata.template,
      timestamp: metadata.timestamp,
      version: metadata.version,
      coordinates: metadata.coordinates,
      lastAccessed: new Date().toISOString(),
      accessCount: 1,
      // Spread any additional properties
      ...metadata,
    };

    await this.prisma.processedAsset.create({
      data: {
        cacheKey,
        path,
        type: "template",
        metadata: fullMetadata satisfies Prisma.InputJsonValue,
        hash,
      },
    });
  }

  private validateTemplateRequirements(
    template: TemplateKey,
    coordinates?: { lat: number; lng: number }
  ): void {
    const config = TEMPLATE_CONFIGS[template];
    if (!config) throw new Error(`Unknown template: ${template}`);

    // Only validate coordinates requirement
    if (config.requiresCoordinates && !coordinates) {
      throw new Error(`Template ${template} requires coordinates`);
    }
  }

  private async getStoredRunwayResults(
    jobId: string
  ): Promise<RunwayProcessingResult | null> {
    // Check cache first for faster lookups
    if (this.runwayCache.has(jobId)) {
      return this.runwayCache.get(jobId)!;
    }

    // Only query DB if not in cache
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        metadata: true,
      },
    });

    const metadata = job?.metadata as Record<string, any> | null;
    if (
      !metadata?.runwayProcessing?.paths ||
      !metadata?.runwayProcessing?.completedAt
    ) {
      return null;
    }

    const result = {
      paths: metadata.runwayProcessing.paths,
      timestamp: metadata.runwayProcessing.completedAt,
    };

    // Store in memory for fast access
    this.runwayCache.set(jobId, result);

    return result;
  }

  private async processRunwayVideos(
    inputFiles: string[],
    jobId: string,
    _isRegeneration?: boolean,
    _regenerationContext?: RegenerationContext,
    coordinates?: { lat: number; lng: number }
  ): Promise<{ runwayVideos: string[]; mapVideo: string | null }> {
    this.monitorMemoryUsage(jobId);

    const mapVideoPromise = coordinates
      ? this.generateMapVideoForTemplate(coordinates, jobId)
      : Promise.resolve(null);

    // Check if we're in regeneration mode
    if (_isRegeneration && _regenerationContext) {
      logger.info(`[${jobId}] Processing regeneration with context`, {
        toRegenerate: _regenerationContext.photosToRegenerate.length,
        existing: _regenerationContext.existingPhotos.length,
      });

      // First check for cached videos for all photos
      const existingVideos = await Promise.all(
        _regenerationContext.existingPhotos.map(async (photo) => {
          try {
            const cacheKey = this.generateCacheKey({
              type: "runway",
              inputFiles: [photo.processedFilePath],
            });
            const cached = await this.prisma.processedAsset.findFirst({
              where: {
                type: "runway",
                cacheKey,
                createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
              },
            });

            if (cached?.path) {
              try {
                await fs.access(cached.path);
                logger.info(
                  `[${jobId}] Found cached Runway video for photo ${photo.id}`
                );
                return {
                  ...photo,
                  processedFilePath: cached.path,
                };
              } catch {
                await this.prisma.processedAsset.delete({
                  where: { id: cached.id },
                });
              }
            }
          } catch (error) {
            logger.debug(
              `[${jobId}] No cached video found for photo ${photo.id}`,
              {
                error,
              }
            );
          }

          // If no cached video found, process it with Runway
          logger.info(`[${jobId}] Processing existing photo with Runway`, {
            id: photo.id,
            path: photo.processedFilePath,
          });

          const processedVideo = await this.processImageWithRunway(
            photo.processedFilePath,
            photo.order,
            jobId
          );

          if (!processedVideo) {
            logger.error(
              `[${jobId}] Failed to process existing photo ${photo.id}`
            );
            return null;
          }

          return {
            ...photo,
            processedFilePath: processedVideo,
          };
        })
      );

      // Process photos marked for regeneration
      const regeneratedVideos = await Promise.all(
        _regenerationContext.photosToRegenerate.map(async (photo) => {
          logger.info(`[${jobId}] Processing regeneration for photo`, {
            id: photo.id,
            path: photo.processedFilePath,
          });

          // Process single photo with Runway
          const processedVideo = await this.processImageWithRunway(
            photo.processedFilePath,
            photo.order,
            jobId
          );

          if (!processedVideo) {
            logger.error(`[${jobId}] Failed to process photo ${photo.id}`);
            return null;
          }

          return {
            ...photo,
            processedFilePath: processedVideo,
          };
        })
      );

      // Combine regenerated and existing videos, filtering out nulls
      const validExistingVideos = existingVideos.filter(
        (v): v is NonNullable<typeof v> => v !== null
      );
      const validRegeneratedVideos = regeneratedVideos.filter(
        (v): v is NonNullable<typeof v> => v !== null
      );

      const allVideos = [
        ...validRegeneratedVideos,
        ...validExistingVideos,
      ].sort((a, b) => (a.order || 0) - (b.order || 0));

      const mapVideo = await mapVideoPromise;

      logger.info(`[${jobId}] Combined all videos for template processing`, {
        existingCount: validExistingVideos.length,
        regeneratedCount: validRegeneratedVideos.length,
        totalVideos: allVideos.length,
        hasMapVideo: !!mapVideo,
      });

      if (allVideos.length === 0) {
        throw new Error("No videos were successfully processed");
      }

      return {
        runwayVideos: allVideos.map((v) => v.processedFilePath),
        mapVideo,
      };
    }

    // For non-regeneration, process all images normally
    try {
      logger.info(`[${jobId}] Input files for Runway processing:`, {
        files: inputFiles,
      });

      // Validate input files (remove regeneration markers for validation)
      this.validateInputFiles(
        inputFiles.map((f) => f.replace("?regenerate=true", ""))
      );

      // Check cache for each input file, skipping cache for regeneration-marked files
      const existingVideos = await Promise.all(
        inputFiles.map(async (file) => {
          // Skip cache check if file is marked for regeneration
          if (file.includes("?regenerate=true")) {
            return null;
          }

          try {
            const cacheKey = this.generateCacheKey({
              type: "runway",
              inputFiles: [file],
            });
            const cached = await this.prisma.processedAsset.findFirst({
              where: {
                type: "runway",
                cacheKey,
                createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
              },
            });

            if (cached?.path) {
              try {
                await fs.access(cached.path);
                logger.info(`[${jobId}] Found cached Runway video for ${file}`);
                return cached.path;
              } catch {
                await this.prisma.processedAsset.delete({
                  where: { id: cached.id },
                });
              }
            }
          } catch (error) {
            logger.debug(`[${jobId}] No cached video found for ${file}`, {
              error,
            });
          }
          return null;
        })
      );

      // Filter files that need processing
      const filesToProcess = inputFiles.filter(
        (file, index) =>
          existingVideos[index] === null || file.includes("?regenerate=true")
      );

      logger.info(`[${jobId}] Runway processing status:`, {
        totalFiles: inputFiles.length,
        existingVideos: existingVideos.filter((v: string | null) => v !== null)
          .length,
        filesToProcess: filesToProcess.length,
        regenerationFiles: filesToProcess.filter((f) =>
          f.includes("?regenerate=true")
        ).length,
      });

      if (filesToProcess.length === 0) {
        logger.info(`[${jobId}] All videos already processed, skipping Runway`);
        const mapVideo = await mapVideoPromise;
        return {
          runwayVideos: existingVideos.filter(
            (v: string | null): v is string => v !== null
          ),
          mapVideo,
        };
      }

      // Convert remaining images to webp if needed, removing regeneration markers
      const webpFiles = await Promise.all(
        filesToProcess.map((file) => {
          const cleanPath = file.replace("?regenerate=true", "");
          return cleanPath.endsWith(".webp")
            ? cleanPath
            : this.convertToWebP(cleanPath);
        })
      );

      logger.info(`[${jobId}] Sending images to Runway`, {
        originalCount: filesToProcess.length,
        webpCount: webpFiles.length,
      });

      // Process each image with Runway
      const runwayTasks = webpFiles.map((imageUrl, index) =>
        this.processImageWithRunway(imageUrl, index, jobId)
      );

      const results = await Promise.all(runwayTasks);
      const successfulVideos = results.filter(
        (result): result is string => result !== null
      );

      logger.info(`[${jobId}] Runway processing completed`, {
        total: results.length,
        success: successfulVideos.length,
        failed: results.length - successfulVideos.length,
      });

      if (successfulVideos.length === 0 && filesToProcess.length > 0) {
        throw new Error("No videos were successfully generated");
      }

      // Cache the newly processed videos (don't cache regenerated videos)
      await Promise.all(
        successfulVideos.map(async (videoPath, index) => {
          const inputFile = filesToProcess[index];
          // Skip caching if this was a regeneration
          if (inputFile.includes("?regenerate=true")) {
            return;
          }

          const cacheKey = this.generateCacheKey({
            type: "runway",
            inputFiles: [inputFile],
          });

          await this.prisma.processedAsset.create({
            data: {
              type: "runway",
              path: videoPath,
              cacheKey,
              hash: require("crypto")
                .createHash("md5")
                .update(videoPath)
                .digest("hex"),
              metadata: {
                sourceFile: inputFile,
                timestamp: Date.now(),
              },
            },
          });
        })
      );

      // Combine existing and new videos in the original order
      const allVideos = inputFiles.map((file, index) => {
        if (
          existingVideos[index] !== null &&
          !file.includes("?regenerate=true")
        ) {
          return existingVideos[index]!;
        }
        const processedIndex = filesToProcess.indexOf(file);
        return processedIndex !== -1 ? successfulVideos[processedIndex] : null;
      });

      // Filter out any null values before returning
      const finalVideos = allVideos.filter(
        (v: string | null): v is string => v !== null
      );

      if (finalVideos.length !== inputFiles.length) {
        throw new Error("Some videos failed to process");
      }

      // Wait for map video generation to complete
      const mapVideo = await mapVideoPromise;

      return {
        runwayVideos: finalVideos,
        mapVideo,
      };
    } catch (error) {
      logger.error(`[${jobId}] Error in Runway processing:`, error);
      throw error;
    }
  }

  private async updateJobProgress(
    jobId: string,
    progress: JobProgress
  ): Promise<void> {
    const {
      stage,
      subStage,
      progress: progressValue,
      message,
      error,
    } = progress;

    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status: error
          ? VideoGenerationStatus.FAILED
          : VideoGenerationStatus.PROCESSING,
        progress: progressValue,
        error: error,
        metadata: {
          currentStage: stage,
          currentSubStage: subStage,
          message,
          lastUpdated: new Date().toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });

    logger.info(
      `[${jobId}] Progress update: ${stage}${
        subStage ? ` - ${subStage}` : ""
      } (${progressValue}%)`,
      {
        stage,
        subStage,
        progress: progressValue,
        message,
        error,
      }
    );
  }

  private async processTemplate(
    template: TemplateKey,
    runwayVideos: string[],
    options: TemplateProcessingOptions & {
      preGeneratedMapVideo?: string | null;
      isRegeneration?: boolean;
    }
  ): Promise<TemplateProcessingResult> {
    const startTime = Date.now();
    try {
      // Update progress at start
      await this.updateJobProgress(options.jobId, {
        stage: "template",
        subStage: `preparing_${template}`,
        progress: 0,
        message: `Starting template generation for ${template}`,
      });

      // Validate template requirements
      this.validateTemplateRequirements(template, options.coordinates);

      // Get template configuration
      const templateConfig = reelTemplates[template];
      if (!templateConfig) {
        throw new Error(`Template configuration not found for ${template}`);
      }

      // For regeneration cases, use the regeneration context if available
      let totalVideoCount = runwayVideos.length;
      let existingCount = 0;

      if (options.isRegeneration) {
        const context = await this.getStoredRunwayResults(options.jobId);

        if (context) {
          // Use the existing photos count from the context
          existingCount = context.paths.length;
          totalVideoCount += existingCount;

          logger.info(`[${options.jobId}] Found existing videos from context`, {
            regeneratedCount: runwayVideos.length,
            existingCount,
            totalCount: totalVideoCount,
            contextTimestamp: context.timestamp,
          });
        } else {
          // Get one of the photos to find the listing ID
          const photo = await this.prisma.photo.findFirst({
            where: { runwayVideoPath: { in: runwayVideos } },
            select: { listingId: true },
          });

          if (photo) {
            // Count existing runway videos for this listing
            existingCount = await this.prisma.photo.count({
              where: {
                listingId: photo.listingId,
                runwayVideoPath: {
                  not: null,
                  notIn: runwayVideos,
                },
              },
            });

            totalVideoCount += existingCount;
            logger.info(`[${options.jobId}] Found existing runway videos`, {
              regeneratedCount: runwayVideos.length,
              existingCount,
              totalCount: totalVideoCount,
              listingId: photo.listingId,
            });
          }
        }
      }

      // Validate minimum video requirement
      if (totalVideoCount < 10) {
        throw new Error(
          `Template ${template} requires at least 10 videos. ` +
            `Got ${totalVideoCount} total videos ` +
            `(${runwayVideos.length} new + ${existingCount} existing). ` +
            `At least 10 videos are required for template ${template}.`
        );
      }

      // Only validate accessibility for non-regeneration cases
      if (!options.isRegeneration) {
        const validVideos = await Promise.all(
          runwayVideos.map(async (videoPath) => {
            try {
              // Check if video exists in S3
              if (videoPath.startsWith("http")) {
                // For S3 URLs, check ProcessedAsset table
                const cached = await this.prisma.processedAsset.findFirst({
                  where: {
                    type: "runway",
                    path: videoPath,
                  },
                });
                return cached ? videoPath : null;
              } else {
                // For local files, check file exists
                await fs.access(videoPath);
                return videoPath;
              }
            } catch {
              return null;
            }
          })
        );

        const accessibleVideos = validVideos.filter(
          (v): v is string => v !== null
        );

        if (accessibleVideos.length < 10) {
          throw new Error(
            `Template ${template} requires at least 10 accessible videos. ` +
              `Found ${accessibleVideos.length} valid videos out of ${runwayVideos.length} total. ` +
              `Some videos may be missing from S3 or local storage.`
          );
        }
      }

      // Adapt sequence for available videos
      const adaptedSequence = templateConfig.sequence.map((index) => {
        // Keep special indices like 'map'
        if (typeof index === "string") {
          return index;
        }
        // Use modulo to wrap around available videos
        return index % runwayVideos.length;
      });

      // Count distribution of indices for logging
      const indexDistribution = adaptedSequence.reduce((acc, index) => {
        if (typeof index === "number") {
          acc[index] = (acc[index] || 0) + 1;
        }
        return acc;
      }, {} as Record<number, number>);

      logger.info(`[${options.jobId}] Template sequence`, {
        template,
        originalSequence: templateConfig.sequence,
        adaptedSequence,
        availableVideos: runwayVideos.length,
        indexDistribution,
      });

      // Ensure we have enough unique videos for variety
      const uniqueIndices = new Set(
        adaptedSequence.filter((i): i is number => typeof i === "number")
      );

      if (uniqueIndices.size < Math.min(2, runwayVideos.length)) {
        throw new Error(
          `Template ${template} requires at least 2 unique video indices ` +
            `for visual variety. Current sequence uses only ${uniqueIndices.size} ` +
            `unique indices out of ${runwayVideos.length} available videos.`
        );
      }

      // Validate that all input videos exist
      await this.updateJobProgress(options.jobId, {
        stage: "template",
        subStage: `validating_${template}`,
        progress: 10,
        message: "Validating input videos",
      });

      const videoValidation = await Promise.all(
        runwayVideos.map(async (video, index) => {
          try {
            await fs.access(video);
            return true;
          } catch (error) {
            logger.error(`[${options.jobId}] Input video ${index} not found:`, {
              path: video,
              error,
            });
            return false;
          }
        })
      );

      if (videoValidation.some((valid) => !valid)) {
        throw new Error("Some input videos are missing");
      }

      // Check if this template requires map video
      const requiresMap = templateConfig.sequence.includes("map");
      const hasMapVideo = requiresMap && !!options.preGeneratedMapVideo;

      // If template requires map but we don't have it, fail early
      if (requiresMap && !hasMapVideo) {
        throw new Error(
          `Template ${template} requires map video but none was provided`
        );
      }

      logger.info(`[${options.jobId}] Template analysis`, {
        template,
        hasMapVideo,
        requiresMap,
        availableVideos: runwayVideos.length,
        isRegeneration: options.isRegeneration,
        musicConfig: templateConfig.music,
      });

      // Determine output directory based on environment variable
      const useTempOutput = process.env.USE_TEMP_OUTPUT === "true";
      const outputDir = useTempOutput
        ? path.join(process.cwd(), "temp", "output")
        : path.join(process.cwd(), "default_output");

      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(
        outputDir,
        `${template}_${Date.now()}_output.mp4`
      );

      // Process template
      await this.updateJobProgress(options.jobId, {
        stage: "template",
        subStage: `generating_${template}`,
        progress: 40,
        message: "Generating template clips",
      });

      const clips = await this.withRetry(async () => {
        // Only include map video if the template requires it
        const inputVideos =
          requiresMap && options.preGeneratedMapVideo
            ? [...runwayVideos, options.preGeneratedMapVideo]
            : runwayVideos;

        logger.info(`Creating template with inputs:`, {
          template,
          inputVideoCount: inputVideos.length,
          hasMapVideo: requiresMap && !!options.preGeneratedMapVideo,
          musicConfig: templateConfig.music,
        });

        const result = await videoTemplateService.createTemplate(
          template,
          inputVideos,
          requiresMap && options.preGeneratedMapVideo
            ? options.preGeneratedMapVideo
            : undefined
        );

        logger.info(`Template creation result:`, {
          clipCount: result?.length || 0,
          clips: result?.map((c) => c.path),
          musicConfig: templateConfig.music,
        });

        return result;
      });

      if (!clips || clips.length === 0) {
        throw new Error(`Template ${template} failed to generate clips`);
      }

      // Stitch videos and save to the output path
      await videoProcessingService.stitchVideos(
        clips.map((clip) => clip.path),
        clips.map((clip) => clip.duration),
        outputPath,
        templateConfig // Pass the full template configuration for music
      );

      // Upload the stitched video to S3
      const s3Key = `listings/${
        options.jobId
      }/templates/${template}_${Date.now()}.mp4`;
      const s3Url = await this.uploadToS3(outputPath, s3Key);

      await this.updateJobProgress(options.jobId, {
        stage: "template",
        subStage: `completed_${template}`,
        progress: 100,
        message: `Template ${template} generated successfully`,
      });

      // Clean up temporary files
      const uniqueClipPaths = Array.from(
        new Set(clips.map((clip) => clip.path))
      );
      logger.info(
        `[${options.jobId}] Cleaning up ${uniqueClipPaths.length} unique clip files`
      );

      await Promise.all(
        uniqueClipPaths.map(async (clipPath) => {
          try {
            // Check if file exists before trying to delete
            try {
              await fs.access(clipPath);
              await fs.unlink(clipPath);
              logger.debug(
                `[${options.jobId}] Successfully cleaned up clip: ${clipPath}`
              );
            } catch (error: any) {
              // File doesn't exist, which is fine
              if (error.code !== "ENOENT") {
                logger.warn(`Failed to cleanup clip ${clipPath}:`, error);
              }
            }
          } catch (error) {
            logger.warn(`Failed to cleanup clip ${clipPath}:`, error);
          }
        })
      );

      // Clean up output file
      try {
        // Check if output file exists before trying to delete
        try {
          await fs.access(outputPath);
          await fs.unlink(outputPath);
          logger.debug(
            `[${options.jobId}] Successfully cleaned up output: ${outputPath}`
          );
        } catch (error: any) {
          // File doesn't exist, which is fine
          if (error.code !== "ENOENT") {
            logger.warn(`Failed to cleanup output ${outputPath}:`, error);
          }
        }
      } catch (error) {
        logger.warn(`Failed to cleanup output ${outputPath}:`, error);
      }

      return {
        template,
        status: "SUCCESS",
        outputPath: s3Url, // Return S3 URL instead of local path
        timestamp: Date.now(),
        processingTime: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      await this.updateJobProgress(options.jobId, {
        stage: "template",
        subStage: `failed_${template}`,
        progress: 0,
        message: `Template ${template} generation failed`,
        error: errorMessage,
      });

      logger.error(
        `[${options.jobId}] Error processing template ${template}:`,
        error
      );

      return {
        template,
        status: "FAILED",
        outputPath: null,
        error: errorMessage,
        timestamp: Date.now(),
        processingTime: Date.now() - startTime,
      };
    }
  }

  protected async processTemplates(
    runwayVideos: string[],
    jobId: string,
    _templateKeys: TemplateKey[], // Ignored - we'll always use REQUIRED_TEMPLATES
    coordinates?: { lat: number; lng: number },
    preGeneratedMapVideo?: string | null,
    isRegeneration?: boolean
  ): Promise<string[]> {
    logger.info(`[${jobId}] Starting template processing`, {
      templateCount: templateKeys.length,
      videoCount: runwayVideos.length,
      hasCoordinates: !!coordinates,
      hasMapVideo: !!preGeneratedMapVideo,
      isRegeneration,
      templates: templateKeys,
    });

    // Add validation for minimum videos only for non-regeneration cases
    if (!isRegeneration && runwayVideos.length < 10) {
      throw new Error(
        `At least 10 videos are required for template generation. Got ${runwayVideos.length}`
      );
    }

    // Generate map video once if needed by any template
    let templateMapVideo = preGeneratedMapVideo;
    if (!templateMapVideo && coordinates) {
      const needsMap = templateKeys.some((key) =>
        reelTemplates[key].sequence.includes("map")
      );
      if (needsMap) {
        logger.info(`[${jobId}] Generating map video for templates`);

        // Try to generate map video with retries
        let retryCount = 0;
        const maxRetries = 3;
        let lastError: Error | null = null;

        while (retryCount < maxRetries) {
          try {
            templateMapVideo = await this.generateMapVideoForTemplate(
              coordinates,
              jobId
            );

            if (templateMapVideo) {
              logger.info(`[${jobId}] Map video generated successfully`, {
                mapVideoPath: templateMapVideo,
                attempt: retryCount + 1,
              });
              break;
            }

            throw new Error("Map video generation returned null");
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error(String(error));
            retryCount++;

            if (retryCount < maxRetries) {
              logger.warn(
                `[${jobId}] Map video generation failed, retrying...`,
                {
                  attempt: retryCount,
                  maxRetries,
                  error: lastError.message,
                }
              );
              // Wait before retrying (exponential backoff)
              await new Promise((resolve) =>
                setTimeout(resolve, Math.pow(2, retryCount) * 1000)
              );
            }
          }
        }

        if (!templateMapVideo) {
          logger.error(
            `[${jobId}] Map video generation failed after ${maxRetries} attempts`,
            {
              error: lastError,
            }
          );
          // Continue without map video, but log the templates that will be affected
          const affectedTemplates = templateKeys.filter((key) =>
            reelTemplates[key].sequence.includes("map")
          );
          logger.warn(
            `[${jobId}] Proceeding without map video, affected templates:`,
            {
              templates: affectedTemplates,
            }
          );
        }
      }
    }

    // Always use all required templates
    const templateResults: (string | null)[] = [];
    
    // Process each required template, continuing even if some fail
    for (const template of REQUIRED_TEMPLATES) {
      try {
        const result = await this.processTemplate(
          template,
          runwayVideos,
          {
            jobId,
            coordinates,
            cacheEnabled: !isRegeneration,
            preGeneratedMapVideo: templateMapVideo,
            isRegeneration: isRegeneration || false,
          }
        );

        if (result.status === "SUCCESS" && result.outputPath) {
          templateResults.push(result.outputPath);
        } else {
          logger.error(`[${jobId}] Template ${template} failed:`, result.error);
          templateResults.push(null);
        }
      } catch (error) {
        logger.error(`[${jobId}] Template ${template} processing failed:`, error);
        templateResults.push(null);
      }
    }

    // Filter out failed templates
    const successfulTemplates = templateResults.filter((path): path is string => 
      typeof path === "string" && path.length > 0
    );

    if (successfulTemplates.length === 0) {
      throw new Error("All template processing attempts failed");
    }

    // Filter out templates that require map video if it's not available
    const finalTemplates = !templateMapVideo
      ? availableTemplates.filter(
          (key) => !reelTemplates[key].sequence.includes("map")
        )
      : availableTemplates;

    if (finalTemplates.length === 0) {
      throw new Error(
        "No templates available after filtering map-dependent templates"
      );
    }

    logger.info(`[${jobId}] Processing templates in batches`, {
      availableTemplates: finalTemplates,
      totalTemplates: finalTemplates.length,
      batchSize: this.BATCH_SIZE,
      totalBatches: Math.ceil(finalTemplates.length / this.BATCH_SIZE),
    });

    const allResults: (string | null)[] = [];

    // Process templates in batches
    for (let i = 0; i < finalTemplates.length; i += this.BATCH_SIZE) {
      const batch = finalTemplates.slice(i, i + this.BATCH_SIZE);
      const batchNumber = Math.floor(i / this.BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(finalTemplates.length / this.BATCH_SIZE);

      logger.info(
        `[${jobId}] Processing batch ${batchNumber}/${totalBatches}`,
        {
          batchTemplates: batch,
          batchSize: batch.length,
        }
      );

      // Process each template in the current batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (templateKey, batchIndex) => {
          try {
            logger.info(
              `[${jobId}] Starting template ${templateKey} (${batchIndex + 1}/${
                batch.length
              }) in batch ${batchNumber}/${totalBatches}`
            );

            const result = await this.processTemplate(
              templateKey,
              runwayVideos,
              {
                jobId,
                coordinates,
                cacheEnabled: !isRegeneration,
                preGeneratedMapVideo: templateMapVideo,
                isRegeneration: isRegeneration || false,
              }
            );

            logger.info(
              `[${jobId}] Template ${templateKey} processing completed in batch ${batchNumber}`,
              {
                status: result.status,
                processingTime: result.processingTime,
                hasOutput: !!result.outputPath,
              }
            );

            if (result.status === "SUCCESS" && result.outputPath) {
              return result.outputPath;
            }

            logger.error(
              `[${jobId}] Template ${templateKey} failed in batch ${batchNumber}`,
              {
                error: result.error,
              }
            );
            return null;
          } catch (error) {
            logger.error(
              `[${jobId}] Template ${templateKey} processing failed with error in batch ${batchNumber}:`,
              {
                error: error instanceof Error ? error.message : "Unknown error",
                stack: error instanceof Error ? error.stack : undefined,
              }
            );
            return null;
          }
        })
      );

      allResults.push(...batchResults);

      // Cleanup after each batch
      if (global.gc) {
        global.gc();
      }

      // Add small delay between batches if not the last batch
      if (batchNumber < totalBatches) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Move cleanup here - after all templates are processed
    logger.info(`[${jobId}] Cleaning up input video files`);
    await this.cleanupClipFiles(runwayVideos);

    // Filter out null values and empty strings
    const successfulTemplates = allResults.filter(
      (path): path is string => typeof path === "string" && path.length > 0
    );

    logger.info(`[${jobId}] All template batches processing completed`, {
      totalTemplates: finalTemplates.length,
      successfulTemplates: successfulTemplates.length,
      failedTemplates: finalTemplates.length - successfulTemplates.length,
      successfulPaths: successfulTemplates,
    });

    if (successfulTemplates.length === 0) {
      throw new Error("No templates were successfully processed");
    }

    return successfulTemplates;
  }

  private async getAvailableTemplates(
    jobId: string,
    requestedTemplates: TemplateKey[]
  ): Promise<TemplateKey[]> {
    try {
      logger.info(`[${jobId}] Getting available templates`, {
        requestedTemplates,
      });

      return requestedTemplates;
    } catch (error) {
      logger.error(`[${jobId}] Error getting available templates`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return requestedTemplates;
    }
  }

  async execute({
    jobId,
    inputFiles,
    template,
    coordinates,
    _isRegeneration,
    _regenerationContext,
    _skipRunway,
  }: ProductionPipelineInput): Promise<string> {
    let runwayVideos = inputFiles;
    let mapVideo: string | null = null;

    try {
      await this.updateJobProgress(jobId, {
        stage: "runway",
        progress: 0,
        message: "Starting video generation pipeline",
      });

      logger.info(`[${jobId}] Starting execution`, {
        defaultTemplate: template,
        inputFilesCount: inputFiles.length,
        isRegeneration: _isRegeneration,
        skipRunway: _skipRunway,
        regenerationContext: _regenerationContext
          ? {
              toRegenerate: _regenerationContext.photosToRegenerate.length,
              existing: _regenerationContext.existingPhotos.length,
            }
          : undefined,
      });

      // Process through Runway if not skipping
      if (!_skipRunway) {
        await this.updateJobProgress(jobId, {
          stage: "runway",
          progress: 0,
          currentFile: 0,
          totalFiles: inputFiles.length,
        });

        // If this is a regeneration, we need to process only the new photos
        // but keep track of all videos for template generation
        if (_isRegeneration && _regenerationContext) {
          logger.info(`[${jobId}] Processing regeneration context`, {
            toRegenerate: _regenerationContext.photosToRegenerate.length,
            existing: _regenerationContext.existingPhotos.length,
            total: _regenerationContext.totalPhotos,
          });

          // Process only the photos that need regeneration
          const processedResults = await this.processRunwayVideos(
            _regenerationContext.photosToRegenerate.map(
              (p) => p.processedFilePath
            ),
            jobId,
            _isRegeneration,
            _regenerationContext,
            coordinates
          );

          // Combine the new processed videos with existing ones in the correct order
          const allVideos = new Array(_regenerationContext.totalPhotos);

          // First, place all existing photos
          _regenerationContext.existingPhotos.forEach((photo) => {
            allVideos[photo.order] = photo.processedFilePath;
          });

          // Then, place all regenerated photos
          _regenerationContext.photosToRegenerate.forEach((photo, index) => {
            allVideos[photo.order] = processedResults.runwayVideos[index];
          });

          // Remove any undefined entries (shouldn't happen, but just in case)
          runwayVideos = allVideos.filter(Boolean);
          mapVideo = processedResults.mapVideo;

          logger.info(
            `[${jobId}] Combined all videos for template processing`,
            {
              totalVideos: runwayVideos.length,
              regeneratedCount: processedResults.runwayVideos.length,
              existingCount: _regenerationContext.existingPhotos.length,
              hasMapVideo: !!mapVideo,
            }
          );
        } else {
          const processedResults = await this.processRunwayVideos(
            inputFiles,
            jobId,
            _isRegeneration,
            _regenerationContext,
            coordinates
          );

          runwayVideos = processedResults.runwayVideos;
          mapVideo = processedResults.mapVideo;
        }
      }

      await this.updateJobProgress(jobId, {
        stage: "template",
        progress: 50,
        message: "Processing templates",
      });

      const availableTemplates = await this.getAvailableTemplates(
        jobId,
        ALL_TEMPLATES
      );

      logger.info(`[${jobId}] Processing templates:`, {
        availableTemplates,
        totalTemplates: availableTemplates.length,
        videoCount: runwayVideos.length,
        hasMapVideo: !!mapVideo,
      });

      const templateResults = await this.processTemplates(
        runwayVideos,
        jobId,
        availableTemplates,
        coordinates,
        mapVideo,
        _isRegeneration
      );

      const successfulTemplates = templateResults.filter(
        (path): path is string => typeof path === "string" && path.length > 0
      );

      if (successfulTemplates.length === 0) {
        throw new Error("No templates were successfully processed");
      }

      // Get the original job to copy its data
      const originalJob = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        select: {
          userId: true,
          listingId: true,
        },
      });

      if (!originalJob) {
        throw new Error("Original job not found");
      }

      // Create a new job for each successful template
      const jobs = await Promise.all(
        successfulTemplates.map(async (outputPath, index) => {
          const templateKey = availableTemplates[index];

          return this.prisma.videoJob.create({
            data: {
              userId: originalJob.userId,
              listingId: originalJob.listingId,
              status: VideoGenerationStatus.COMPLETED,
              progress: 100,
              template: templateKey,
              outputFile: outputPath,
              inputFiles: runwayVideos,
              completedAt: new Date(),
              metadata: {
                template: templateKey,
                processedAt: new Date().toISOString(),
                regeneration: _isRegeneration
                  ? {
                      timestamp: new Date().toISOString(),
                      regeneratedPhotoIds:
                        _regenerationContext?.regeneratedPhotoIds || [],
                      totalPhotos: _regenerationContext?.totalPhotos || 0,
                    }
                  : undefined,
              } satisfies Prisma.InputJsonValue,
            },
          });
        })
      );

      logger.info(`[${jobId}] Created ${jobs.length} video jobs`, {
        templates: jobs.map((job) => job.template),
        outputFiles: jobs.map((job) => job.outputFile),
      });

      // Update the original job to mark it as completed
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.COMPLETED,
          progress: 100,
          outputFile: successfulTemplates[0],
          completedAt: new Date(),
          metadata: {
            templates: templateResults.map((path, index) => ({
              key: availableTemplates[index],
              path: path || "",
            })),
            defaultTemplate: template,
            processedTemplates: successfulTemplates.map((path, index) => ({
              key: availableTemplates[index],
              path,
            })),
            regeneration: _isRegeneration
              ? {
                  timestamp: new Date().toISOString(),
                  regeneratedPhotoIds:
                    _regenerationContext?.regeneratedPhotoIds || [],
                  totalPhotos: _regenerationContext?.totalPhotos || 0,
                }
              : undefined,
          } satisfies Prisma.InputJsonValue,
        },
      });

      // Clean up runway videos after all processing and DB operations are complete
      logger.info(`[${jobId}] Cleaning up runway video files`);
      await this.cleanupClipFiles(runwayVideos);

      return successfulTemplates[0];
    } catch (error) {
      logger.error(`[${jobId}] Pipeline execution failed:`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Clean up runway videos even if there was an error
      try {
        logger.info(`[${jobId}] Cleaning up runway video files after error`);
        await this.cleanupClipFiles(runwayVideos);
      } catch (cleanupError) {
        logger.warn(`[${jobId}] Failed to cleanup runway videos after error`, {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : "Unknown error",
        });
      }

      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        0,
        error instanceof Error ? error.message : "Unknown error"
      );

      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Regenerates videos for specific photos
   * @param jobId - The ID of the video job
   * @param photoIds - Array of photo IDs to regenerate
   */
  async regeneratePhotos(jobId: string, photoIds: string[]): Promise<void> {
    try {
      logger.info(`[${jobId}] Starting photo regeneration`, { photoIds });

      // Check for concurrent regeneration
      const existingJob = await this.prisma.videoJob.findFirst({
        where: {
          id: { not: jobId },
          status: VideoGenerationStatus.PROCESSING,
          metadata: {
            path: ["regeneration", "regeneratedPhotoIds"],
            array_contains: photoIds[0], // Check if any of the photos is being processed
          },
        },
      });

      if (existingJob) {
        throw new Error(
          `Some photos are already being regenerated in job ${existingJob.id}`
        );
      }

      // 1. Get ONLY the photos that need regeneration with their order
      const photosToRegenerate = await this.prisma.photo.findMany({
        where: {
          id: { in: photoIds },
          filePath: { not: undefined },
        },
        select: {
          id: true,
          filePath: true,
          processedFilePath: true,
          status: true,
          order: true,
          listingId: true,
        },
      });

      if (photosToRegenerate.length === 0) {
        throw new Error("No valid photos found for regeneration");
      }

      if (photosToRegenerate.length !== photoIds.length) {
        const foundIds = photosToRegenerate.map((p) => p.id);
        const missingIds = photoIds.filter((id) => !foundIds.includes(id));
        throw new Error(`Some photos were not found: ${missingIds.join(", ")}`);
      }

      const listingId = photosToRegenerate[0].listingId;

      // Verify all photos belong to the same listing
      const differentListings = photosToRegenerate.filter(
        (p) => p.listingId !== listingId
      );
      if (differentListings.length > 0) {
        throw new Error(
          `Photos must belong to the same listing. Found photos from different listings: ${differentListings
            .map((p) => p.id)
            .join(", ")}`
        );
      }

      // 2. Get ALL photos for this listing
      const allListingPhotos = await this.prisma.photo.findMany({
        where: {
          listingId: listingId,
          processedFilePath: { not: null },
          status: "completed",
        },
        select: {
          id: true,
          filePath: true,
          processedFilePath: true,
          runwayVideoPath: true,
          status: true,
          order: true,
          createdAt: true,
        },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      });

      // Get non-regenerating photos
      const nonRegeneratingPhotos = allListingPhotos.filter(
        (p) => !photoIds.includes(p.id)
      );

      // For non-regenerating photos, we'll use their existing videos
      const existingVideos = nonRegeneratingPhotos
        .filter((p) => p.runwayVideoPath)
        .map((p) => p.runwayVideoPath!);

      logger.info(`[${jobId}] Video availability analysis`, {
        totalPhotos: allListingPhotos.length,
        photosToRegenerate: photosToRegenerate.length,
        existingPhotos: nonRegeneratingPhotos.length,
        existingVideos: existingVideos.length,
      });

      // Validate processed file paths only for non-regenerating photos
      const invalidPhotos = nonRegeneratingPhotos.filter(
        (p) => !p.processedFilePath?.startsWith("http")
      );
      if (invalidPhotos.length > 0) {
        throw new Error(
          `Invalid processed file paths found for photos: ${invalidPhotos
            .map((p) => p.id)
            .join(", ")}`
        );
      }

      // Store original status for rollback
      const originalStatuses = await this.prisma.photo.findMany({
        where: { id: { in: photoIds } },
        select: { id: true, status: true },
      });

      // 3. Update status to processing for selected photos only
      try {
        await this.prisma.photo.updateMany({
          where: { id: { in: photoIds } },
          data: { status: "processing", error: null },
        });
      } catch (error) {
        logger.error(`[${jobId}] Failed to update photo statuses`, { error });
        throw error;
      }

      // Normalize photo orders to ensure no gaps
      const normalizedPhotos = [...allListingPhotos]
        .sort((a, b) => {
          if (a.order === null && b.order === null) return 0;
          if (a.order === null) return 1;
          if (b.order === null) return -1;
          if (a.order === b.order) {
            return a.createdAt.getTime() - b.createdAt.getTime();
          }
          return a.order - b.order;
        })
        .map((photo, index) => ({
          ...photo,
          order: index,
        }));

      // 4. Create regeneration context with regeneration marker in file paths
      const regenerationContext: RegenerationContext = {
        photosToRegenerate: photosToRegenerate.map((p) => ({
          id: p.id,
          processedFilePath: p.processedFilePath?.includes("?")
            ? p.processedFilePath + "&regenerate=true"
            : (p.processedFilePath || p.filePath) + "?regenerate=true",
          order: normalizedPhotos.find((np) => np.id === p.id)?.order || 0,
        })),
        existingPhotos: normalizedPhotos
          .filter((p) => !photoIds.includes(p.id))
          .map((p) => ({
            id: p.id,
            processedFilePath: p.processedFilePath!,
            order: p.order,
          })),
        regeneratedPhotoIds: photoIds,
        totalPhotos: allListingPhotos.length,
      };

      logger.info(`[${jobId}] Created regeneration context`, {
        toRegenerate: regenerationContext.photosToRegenerate.length,
        existing: regenerationContext.existingPhotos.length,
        total: regenerationContext.totalPhotos,
      });

      // Get job and listing details for coordinates
      const job = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        include: { listing: true },
      });

      if (!job?.listing) {
        throw new Error("Job or listing not found");
      }

      // Parse coordinates if available
      let coordinates: { lat: number; lng: number } | undefined;
      if (job.listing.coordinates) {
        try {
          const coordsData =
            typeof job.listing.coordinates === "string"
              ? JSON.parse(job.listing.coordinates)
              : job.listing.coordinates;

          coordinates = {
            lat: Number(coordsData.lat),
            lng: Number(coordsData.lng),
          };
        } catch (err) {
          logger.warn(`[${jobId}] Failed to parse coordinates`, { error: err });
        }
      }

      const jobMetadata = job.metadata as {
        defaultTemplate?: TemplateKey;
      } | null;
      const currentTemplate: TemplateKey =
        jobMetadata?.defaultTemplate || "storyteller";

      // Prepare all files in correct order
      const allFiles = [
        ...regenerationContext.photosToRegenerate,
        ...regenerationContext.existingPhotos,
      ]
        .sort((a, b) => a.order - b.order)
        .map((p) => p.processedFilePath);

      let outputPath: string;

      try {
        outputPath = await this.execute({
          jobId,
          inputFiles: allFiles,
          template: currentTemplate,
          coordinates,
          _isRegeneration: true,
          _regenerationContext: regenerationContext,
          _skipRunway: false,
        });

        // 8. Update job with detailed results
        await this.prisma.videoJob.update({
          where: { id: jobId },
          data: {
            outputFile: outputPath,
            status: VideoGenerationStatus.COMPLETED,
            completedAt: new Date(),
            error: null,
            metadata: {
              regeneration: {
                timestamp: new Date().toISOString(),
                regeneratedPhotoIds: photoIds,
                totalPhotos: regenerationContext.totalPhotos,
                originalOrders: photosToRegenerate.map((p) => ({
                  id: p.id,
                  order: p.order,
                })),
                regeneratedSegments: photosToRegenerate.map(p => ({
                  id: p.id,
                  order: p.order,
                  originalPath: p.processedFilePath,
                  newPath: outputPath
                })),
                reusedSegments: nonRegeneratingPhotos.map(p => ({
                  id: p.id,
                  order: p.order,
                  path: p.runwayVideoPath
                })),
                processingTime: Date.now() - startTime,
              },
            } satisfies Prisma.InputJsonValue,
          },
        });

        // 9. Update regenerated photos status
        await this.prisma.photo.updateMany({
          where: { id: { in: photoIds } },
          data: {
            status: "completed",
            error: null,
          },
        });
      } catch (error) {
        // Rollback to original statuses if execution fails
        await Promise.all(
          originalStatuses.map(({ id, status }) =>
            this.prisma.photo.update({
              where: { id },
              data: { status },
            })
          )
        );
        throw error;
      }

      logger.info(`[${jobId}] Photo regeneration completed`, {
        photoIds,
        outputPath: outputPath || "No output path generated",
        totalPhotos: regenerationContext.totalPhotos,
      });
    } catch (error) {
      logger.error(`[${jobId}] Photo regeneration failed`, { error });
      await this.prisma.photo.updateMany({
        where: { id: { in: photoIds } },
        data: {
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        },
      });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    await this.resourceManager.cleanup();
  }

  private async updateJobStatus(
    jobId: string,
    status: VideoGenerationStatus,
    progress: number = 0,
    error?: string
  ): Promise<void> {
    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: { status, progress, error },
    });
  }

  private validateInputFiles(inputFiles: string[]): void {
    if (!inputFiles.length) {
      throw new Error("No input files provided");
    }
    inputFiles.forEach((file, index) => {
      if (typeof file !== "string" || !file.trim()) {
        throw new Error(`Invalid input file at index ${index}: ${file}`);
      }
      if (!file.match(/\.(jpg|jpeg|png|webp|mp4|mov)$/i)) {
        throw new Error(`Unsupported file format at index ${index}: ${file}`);
      }
    });
  }

  private async generateMapVideoForTemplate(
    coordinates: { lat: number; lng: number },
    jobId: string
  ): Promise<string | null> {
    try {
      // Generate a deterministic cache key based on coordinates
      const cacheKey = this.generateCacheKey({ 
        type: "map", 
        coordinates: {
          // Round to 6 decimal places for consistent caching of nearby locations
          lat: Number(coordinates.lat.toFixed(6)),
          lng: Number(coordinates.lng.toFixed(6))
        }
      });

      // Check DB cache first
      const cached = await this.prisma.processedAsset.findFirst({
        where: {
          type: "map",
          cacheKey,
          // Keep map videos cached for 7 days
          createdAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      if (cached) {
        // For S3 paths, no need to check file existence
        if (cached.path.startsWith('http') || cached.path.startsWith('s3://')) {
          logger.info(`[${jobId}] Using cached map video from S3: ${cached.path}`);
          return cached.path;
        }

        // For local files, verify existence
        try {
          await fs.access(cached.path);
          logger.info(`[${jobId}] Using cached map video from disk: ${cached.path}`);
          return cached.path;
        } catch (error) {
          logger.warn(`[${jobId}] Cached map video not found, will regenerate`, {
            path: cached.path,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          
          // Remove invalid cache entry
          await this.prisma.processedAsset.delete({
            where: { id: cached.id },
          });
        }
      }

      logger.info(`[${jobId}] Generating new map video for coordinates`, {
        lat: coordinates.lat,
        lng: coordinates.lng,
        cacheKey
      });

      // Generate new map video with retries
      const mapVideo = await this.withRetry(
        async () => {
          const video = await mapCaptureService.generateMapVideo(coordinates, jobId);
          if (!video) throw new Error("Map video generation returned null");
          return video;
        },
        this.MAX_RETRIES
      );

      // Upload to S3 if configured
      let finalPath = mapVideo;
      if (process.env.UPLOAD_MAPS_TO_S3 === 'true') {
        try {
          const s3Key = `maps/${jobId}/${path.basename(mapVideo)}`;
          const s3Url = await this.uploadToS3(mapVideo, s3Key);
          finalPath = s3Url;
          
          // Clean up local file after successful S3 upload
          await fs.unlink(mapVideo);
        } catch (error) {
          logger.warn(`[${jobId}] Failed to upload map video to S3, using local path`, {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Track for cleanup if keeping locally
      if (finalPath === mapVideo) {
        await this.resourceManager.trackResource(mapVideo);
      }

      // Cache the result
      await this.prisma.processedAsset.create({
        data: {
          type: "map",
          path: finalPath,
          cacheKey,
          hash: require("crypto").createHash("md5").update(finalPath).digest("hex"),
          metadata: {
            coordinates,
            timestamp: Date.now(),
            jobId,
            originalPath: mapVideo,
            isS3: finalPath.startsWith('http') || finalPath.startsWith('s3://')
          },
        },
      });

      return finalPath;
    } catch (error) {
      logger.error(`[${jobId}] Map video generation failed:`, error);
      return null;
    }
  }

  private async convertToWebP(filePath: string): Promise<string> {
    // If already webp, return as is
    if (filePath.endsWith(".webp")) {
      return filePath;
    }

    try {
      // Since we don't have getWebPUrl, we'll assume the file is already in WebP format
      // This is safe because our upload process converts images to WebP
      return filePath;
    } catch (error) {
      logger.warn(`Error converting to WebP: ${filePath}`, error);
      return filePath;
    }
  }

  private async processImageWithRunway(
    imageUrl: string,
    index: number,
    jobId: string
  ): Promise<string | null> {
    try {
      const videoPath = await this.withRetry(
        () => runwayService.generateVideo(imageUrl, index),
        this.MAX_RETRIES
      );

      if (videoPath) {
        await this.updateDetailedProgress(jobId, {
          stage: "runway",
          progress: ((index + 1) / 10) * 100, // Assuming 10 images max
          totalSteps: 10,
          currentStep: index + 1,
        });
      }

      return videoPath;
    } catch (error) {
      logger.error(`[${jobId}] Error processing image ${imageUrl}:`, error);
      return null;
    }
  }

  private async uploadToS3(filePath: string, s3Key: string): Promise<string> {
    try {
      // Check for required environment variables
      const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
      const region = process.env.AWS_REGION || "us-east-2";
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

      if (!bucket || !region || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "Missing required AWS environment variables. Please check AWS_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are set."
        );
      }

      const fileContent = await fs.readFile(filePath);
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucket,
          Key: s3Key,
          Body: fileContent,
          ContentType: "video/mp4",
        },
      });

      await upload.done();
      return `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
    } catch (error) {
      logger.error("Error uploading to S3:", error);
      throw error;
    }
  }

  private async getJobListing(jobId: string) {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      include: { listing: true },
    });

    if (!job?.listing) {
      throw new Error(`No listing found for job ${jobId}`);
    }

    return job.listing;
  }

  private async cleanupClipFiles(clipPaths: string[]) {
    try {
      const uniqueClips = [...new Set(clipPaths)];
      logger.info(`Cleaning up ${uniqueClips.length} unique clip files`);

      for (const clipPath of uniqueClips) {
        try {
          // Check if file exists before attempting deletion
          await fs.access(clipPath);
          await fs.unlink(clipPath);
          logger.debug(`Successfully cleaned up clip: ${clipPath}`);
        } catch (error: any) {
          // Only warn if error is not "file not found"
          if (error.code !== "ENOENT") {
            logger.warn(`Failed to cleanup clip ${clipPath}:`, { error });
          }
        }
      }
    } catch (error) {
      logger.error("Error during clip cleanup", { error });
      // Don't throw - cleanup failure shouldn't fail the whole process
    }
  }
}
