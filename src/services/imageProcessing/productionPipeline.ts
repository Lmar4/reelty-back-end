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
import { s3VideoService } from "../video/s3-video.service";
import { videoTemplateService } from "../video/video-template.service";
import { reelTemplates, TemplateKey } from "./templates/types";
import { s3Service } from "../storage/s3.service";

function isPhotoWithProcessedFile(photo: {
  processedFilePath: string | null;
}): photo is { processedFilePath: string } {
  return photo.processedFilePath !== null;
}

export interface VideoClip {
  path: string;
  duration: number;
}

interface ProductionPipelineInput {
  jobId: string;
  inputFiles: string[];
  template: TemplateKey;
  coordinates?: { lat: number; lng: number };
  _isRegeneration?: boolean;
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
  "hyperpop",
];

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

export class ProductionPipeline {
  private prisma: PrismaClient;
  private resourceManager: ResourceManager;
  private readonly MAX_RETRIES = 3;
  private readonly MEMORY_WARNING_THRESHOLD = 0.8; // 80% heap usage
  private batchedUpdates: BatchProgressUpdate = {
    stepsCompleted: [],
    overallProgress: 0,
    currentStage: "runway",
  };
  private runwayCache: Map<string, RunwayProcessingResult> = new Map();

  constructor() {
    this.prisma = new PrismaClient();
    this.resourceManager = new ResourceManager();
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

  private async saveRunwayResults(
    jobId: string,
    results: RunwayProcessingResult
  ): Promise<void> {
    // Update cache first
    this.runwayCache.set(jobId, results);

    const existingJob = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
    });
    const existingMetadata =
      (existingJob?.metadata as Record<string, any>) || {};

    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        metadata: {
          ...existingMetadata,
          runwayProcessing: {
            completedAt: results.timestamp,
            paths: results.paths,
          },
        },
      },
    });
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
    _isRegeneration?: boolean
  ): Promise<string[]> {
    // Monitor memory at start of processing
    this.monitorMemoryUsage(jobId);

    // First check if we have stored results
    const storedResults = await this.getStoredRunwayResults(jobId);
    if (storedResults) {
      logger.info(`[${jobId}] Using previously processed Runway results`);
      // Verify files still exist
      const existingFiles = await Promise.all(
        storedResults.paths.map(async (path) => {
          try {
            await fs.access(path);
            return path;
          } catch {
            return null;
          }
        })
      );

      const validFiles = existingFiles.filter(
        (path): path is string => path !== null
      );
      if (validFiles.length === storedResults.paths.length) {
        return validFiles;
      }
      logger.warn(
        `[${jobId}] Some stored Runway files are missing, reprocessing`
      );
    }

    if (_isRegeneration) {
      const existingVideos = await this.prisma.processedAsset.findMany({
        where: {
          metadata: {
            path: ["type"],
            equals: "runway",
          },
          path: { in: inputFiles },
        },
      });

      if (existingVideos.length > 0) {
        return existingVideos.map((v) => v.path);
      }
    }

    // Log input files for debugging
    logger.info(`[${jobId}] Input files for Runway processing:`, {
      files: inputFiles,
    });

    // Convert input paths to WebP paths using s3VideoService
    const webpFiles = await Promise.all(
      inputFiles.map(async (filePath) => {
        try {
          // Use s3Key from database instead of parsing URL
          const photo = await this.prisma.photo.findFirst({
            where: {
              filePath,
            },
          });

          if (!photo) {
            throw new Error(`Photo not found for path: ${filePath}`);
          }

          // Use s3Key to construct proper URL
          const webpUrl = s3Service.getPublicUrl(
            photo.s3Key
              .replace("/original/", "/webp/")
              .replace(/\.[^/.]+$/, ".webp")
          );

          logger.info(`[${jobId}] WebP conversion:`, {
            original: filePath,
            webp: webpUrl,
            photoId: photo.id,
          });

          return webpUrl;
        } catch (error) {
          logger.warn(
            `[${jobId}] Error processing WebP path for ${filePath}:`,
            error
          );
          return filePath;
        }
      })
    );

    logger.info(`[${jobId}] Sending images to Runway`, {
      originalCount: inputFiles.length,
      webpCount: webpFiles.filter((path) => path.endsWith(".webp")).length,
    });

    let successCount = 0;
    let failureCount = 0;

    const runwayResults = await Promise.all(
      webpFiles.map(async (file, index) => {
        try {
          const videoPath = await this.withRetry(
            () => runwayService.generateVideo(file, index),
            this.MAX_RETRIES
          );

          if (videoPath) {
            successCount++;
            await this.updateDetailedProgress(jobId, {
              stage: "runway",
              progress: (index / webpFiles.length) * 100,
              totalSteps: webpFiles.length,
              currentStep: index + 1,
            });
          } else {
            failureCount++;
          }
          return videoPath;
        } catch (error) {
          failureCount++;
          logger.error(`[${jobId}] Error processing file ${file}:`, error);
          return null;
        }
      })
    );

    logger.info(`[${jobId}] Runway processing completed`, {
      total: inputFiles.length,
      success: successCount,
      failed: failureCount,
    });

    const successfulVideos = runwayResults.filter(
      (path): path is string => path !== null
    );
    if (successfulVideos.length === 0) {
      throw new Error("No videos were successfully processed by Runway");
    }

    // Store successful results
    await this.saveRunwayResults(jobId, {
      paths: successfulVideos,
      timestamp: Date.now(),
    });

    // Monitor memory after processing
    this.monitorMemoryUsage(jobId);

    return successfulVideos;
  }

  private async processTemplate(
    template: TemplateKey,
    runwayVideos: string[],
    options: TemplateProcessingOptions & {
      preGeneratedMapVideo?: string | null;
    }
  ): Promise<TemplateProcessingResult> {
    const startTime = Date.now();
    try {
      // Validate template requirements
      this.validateTemplateRequirements(template, options.coordinates);

      // Check cache if enabled
      if (options.cacheEnabled !== false) {
        const cacheKey = this.generateCacheKey({
          template,
          inputFiles: runwayVideos,
          coordinates: options.coordinates,
        });
        const cached = await this.getCachedAsset(cacheKey);
        if (cached) {
          logger.info(`[${options.jobId}] Using cached template ${template}`);
          return {
            template,
            status: "SUCCESS",
            outputPath: cached.path,
            timestamp: Date.now(),
            processingTime: 0,
          };
        }
      }

      // Set hasMapVideo based on preGeneratedMapVideo
      const hasMapVideo = !!options.preGeneratedMapVideo;
      logger.info(`[${options.jobId}] Template analysis`, {
        template,
        hasMapVideo,
        availableVideos: runwayVideos.length,
      });

      // Process template
      const clips = await this.withRetry(async () => {
        const inputVideos = options.preGeneratedMapVideo
          ? [...runwayVideos, options.preGeneratedMapVideo]
          : runwayVideos;
        return await videoTemplateService.createTemplate(
          template,
          inputVideos,
          options.preGeneratedMapVideo || undefined
        );
      });

      if (!clips || clips.length === 0) {
        throw new Error(`Template ${template} failed to generate clips`);
      }

      // Cache result if enabled
      if (options.cacheEnabled !== false) {
        await this.cacheAsset(
          this.generateCacheKey({
            template,
            inputFiles: runwayVideos,
            coordinates: options.coordinates,
          }),
          clips[0].path,
          {
            template,
            coordinates: options.coordinates,
            timestamp: Date.now(),
            version: "1.0",
          }
        );
      }

      return {
        template,
        status: "SUCCESS",
        outputPath: clips[0].path,
        timestamp: Date.now(),
        processingTime: Date.now() - startTime,
      };
    } catch (error) {
      logger.error(
        `[${options.jobId}] Error processing template ${template}:`,
        error
      );
      return {
        template,
        status: "FAILED",
        outputPath: null,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: Date.now(),
        processingTime: Date.now() - startTime,
      };
    }
  }

  protected async processTemplates(
    runwayVideos: string[],
    jobId: string,
    templateKeys: TemplateKey[],
    coordinates?: { lat: number; lng: number },
    preGeneratedMapVideo?: string | null
  ): Promise<string[]> {
    logger.info(`[${jobId}] Creating templates`);
    const results: TemplateProcessingResult[] = [];
    const BATCH_SIZE = 3;

    // Validate template requirements first
    for (const template of templateKeys) {
      try {
        this.validateTemplateRequirements(template, coordinates);
      } catch (error) {
        throw error;
      }
    }

    // Process templates in parallel batches
    for (let i = 0; i < templateKeys.length; i += BATCH_SIZE) {
      const batch = templateKeys.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((template) =>
          this.processTemplate(template, runwayVideos, {
            jobId,
            coordinates,
            cacheEnabled: true,
            preGeneratedMapVideo,
          })
        )
      );
      results.push(...batchResults);

      // Update progress after each batch
      await this.updateDetailedProgress(jobId, {
        stage: "template",
        progress: ((i + batch.length) / templateKeys.length) * 100,
        totalSteps: templateKeys.length,
        currentStep: i + batch.length,
      });
    }

    // Store results in job metadata
    await this.updateTemplateResults(jobId, results);

    // Return successful template paths
    const successfulTemplates = results
      .filter(
        (
          result
        ): result is TemplateProcessingResult & {
          status: "SUCCESS";
          outputPath: string;
        } => result.status === "SUCCESS" && result.outputPath !== null
      )
      .map((result) => result.outputPath);

    if (successfulTemplates.length === 0) {
      const failedTemplates = results
        .filter((r) => r.status === "FAILED")
        .map((r) => ({
          template: r.template,
          error: r.error || "Unknown error",
        }));

      const errorMessage = `No templates were successfully generated. Failed templates:\n${failedTemplates
        .map((f) => `- ${f.template}: ${f.error}`)
        .join("\n")}`;

      logger.error(`[${jobId}] ${errorMessage}`, { failedTemplates });
      throw new Error(errorMessage);
    }

    return successfulTemplates;
  }

  private async updateTemplateResults(
    jobId: string,
    results: TemplateProcessingResult[]
  ): Promise<void> {
    const existingJob = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
    });

    const metadata = existingJob?.metadata as Record<string, unknown> | null;

    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        metadata: {
          ...(metadata || {}),
          templateResults: results.map((result) => ({
            template: result.template,
            status: result.status,
            error: result.error,
            timestamp: result.timestamp,
            processingTime: result.processingTime,
          })),
        } satisfies Prisma.InputJsonValue,
      },
    });
  }

  async execute({
    jobId,
    inputFiles,
    template,
    coordinates,
    _isRegeneration,
  }: ProductionPipelineInput): Promise<string> {
    try {
      logger.info(`[${jobId}] Starting execution`, {
        template,
        inputFilesCount: inputFiles.length,
        isRegeneration: _isRegeneration,
      });

      // Validate template exists
      if (!TEMPLATE_CONFIGS[template]) {
        throw new Error(`Unknown template: ${template}`);
      }

      const templateConfig = reelTemplates[template];
      let mapVideo: string | null = null;

      // Check if template sequence includes map
      if (templateConfig.sequence?.includes("map")) {
        // Get coordinates if not provided
        if (!coordinates) {
          const job = await this.prisma.videoJob.findUnique({
            where: { id: jobId },
            include: { listing: true },
          });

          if (job?.listing?.coordinates) {
            try {
              const coordsData =
                typeof job.listing.coordinates === "string"
                  ? JSON.parse(job.listing.coordinates)
                  : job.listing.coordinates;

              coordinates = {
                lat: Number(coordsData.lat),
                lng: Number(coordsData.lng),
              };
              logger.info(`[${jobId}] Found coordinates for map:`, coordinates);
            } catch (err) {
              logger.warn(`[${jobId}] Failed to parse coordinates`, {
                error: err,
              });
            }
          }
        }

        // Throw error if coordinates are still not available
        if (!coordinates) {
          throw new Error(
            `Template ${template} requires coordinates but none were provided`
          );
        }

        // Generate map video with retries
        logger.info(`[${jobId}] Generating map video for coordinates:`, {
          coordinates,
        });
        mapVideo = await this.withRetry(
          () => this.generateMapVideoForTemplate(coordinates!, jobId),
          this.MAX_RETRIES
        );

        if (!mapVideo) {
          throw new Error("Failed to generate required map video");
        }
        logger.info(`[${jobId}] Map video generated successfully:`, {
          mapVideoPath: mapVideo,
        });
      }

      // Process runway videos
      const runwayResults = await this.processRunwayVideos(
        inputFiles,
        jobId,
        _isRegeneration
      );

      // Process templates with map video if needed
      const templateResults = await this.processTemplates(
        runwayResults,
        jobId,
        [template],
        coordinates,
        mapVideo // Pass the generated map video
      );

      const finalVideo = templateResults[0];
      const s3Url = await this.uploadFinalVideoToS3(finalVideo);

      await this.updateJobStatus(jobId, VideoGenerationStatus.COMPLETED, 100);

      const job = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
      });

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          outputFile: s3Url,
          completedAt: new Date(),
          metadata: {
            ...(typeof job?.metadata === "object" ? job.metadata : {}),
            mapVideo: mapVideo
              ? {
                  path: mapVideo,
                  coordinates,
                  generatedAt: new Date().toISOString(),
                }
              : undefined,
          } satisfies Prisma.InputJsonValue,
        },
      });

      logger.info(`[${jobId}] Job completed successfully`, {
        s3Url,
        hasMapVideo: !!mapVideo,
      });

      return s3Url;
    } catch (error) {
      logger.error(`[${jobId}] Production pipeline error`, { error });
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        0,
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Regenerates videos for specific photos
   * @param jobId - The ID of the video job
   * @param photoIds - Array of photo IDs to regenerate
   */
  async regeneratePhotos(jobId: string, photoIds: string[]): Promise<void> {
    try {
      logger.info(`[${jobId}] Starting photo regeneration`, {
        photoIds,
        jobId,
      });

      // Get only the specific photos to regenerate
      const photos = await this.prisma.photo.findMany({
        where: {
          id: { in: photoIds },
          processedFilePath: { not: null },
        },
        select: {
          id: true,
          processedFilePath: true,
          status: true,
        },
      });

      if (photos.length === 0) {
        throw new Error("No valid photos found for regeneration");
      }

      // Get the job details
      const job = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        include: {
          listing: true,
        },
      });

      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // Filter out photos without processed file paths
      const validPhotos = photos.filter(isPhotoWithProcessedFile);

      if (validPhotos.length === 0) {
        throw new Error("No photos with processed files found");
      }

      // Update only selected photos status to processing
      await this.prisma.photo.updateMany({
        where: { id: { in: photoIds } },
        data: { status: "PROCESSING", error: null },
      });

      // Process all templates but only for selected photos
      const templates: TemplateKey[] = ALL_TEMPLATES;

      // Get coordinates from job
      let coordinates: { lat: number; lng: number } | undefined;
      if (job.listing?.coordinates) {
        try {
          const coordsString =
            typeof job.listing.coordinates === "string"
              ? job.listing.coordinates
              : JSON.stringify(job.listing.coordinates);
          const parsedCoords = JSON.parse(coordsString);

          if (
            typeof parsedCoords === "object" &&
            "lat" in parsedCoords &&
            "lng" in parsedCoords
          ) {
            coordinates = {
              lat: Number(parsedCoords.lat),
              lng: Number(parsedCoords.lng),
            };
          }
        } catch (error) {
          logger.warn(`[${jobId}] Failed to parse coordinates`, {
            coordinates: job.listing.coordinates,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      // Execute the pipeline only for selected photos
      const templateResults = await Promise.all(
        templates.map(async (template) => {
          try {
            const inputFiles = validPhotos.map((photo) => {
              if (!photo.processedFilePath) {
                throw new Error(`Missing processed file path for photo`);
              }
              return photo.processedFilePath;
            });

            const outputPath = await this.execute({
              jobId,
              inputFiles, // Now only contains files for selected photos
              template,
              coordinates,
              _isRegeneration: true,
            });

            return { template, outputPath, error: null };
          } catch (error) {
            logger.error(`[${jobId}] Template ${template} generation failed`, {
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return {
              template,
              outputPath: null,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        })
      );

      // Get the primary template's output (storyteller)
      const primaryOutput = templateResults.find(
        (result) => result.template === "storyteller"
      )?.outputPath;

      if (!primaryOutput) {
        throw new Error("Failed to generate primary template (storyteller)");
      }

      // Update the job with the new output file and template results
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          outputFile: primaryOutput,
          status: VideoGenerationStatus.COMPLETED,
          completedAt: new Date(),
          error: null,
          metadata: {
            templates: templateResults.map((result) => ({
              key: result.template,
              path: result.outputPath,
              error: result.error,
            })),
          },
        },
      });

      // Update photos status to completed
      await this.prisma.photo.updateMany({
        where: { id: { in: photoIds } },
        data: { status: "COMPLETED", error: null },
      });

      logger.info(`[${jobId}] Photo regeneration completed successfully`, {
        photoIds,
        templateResults: templateResults.map((r) => ({
          template: r.template,
          success: !!r.outputPath,
        })),
      });
    } catch (error) {
      logger.error(`[${jobId}] Photo regeneration failed`, {
        photoIds,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Update photos status to failed
      await this.prisma.photo.updateMany({
        where: { id: { in: photoIds } },
        data: {
          status: "FAILED",
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

  private async uploadFinalVideoToS3(videoPath: string): Promise<string> {
    const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
    if (!bucketName) {
      throw new Error("AWS_BUCKET environment variable is not defined");
    }

    const s3Key = `videos/${Date.now()}-${videoPath.split("/").pop()}`;
    return await s3VideoService.uploadVideo(
      videoPath,
      `s3://${bucketName}/${s3Key}`
    );
  }

  private validateInputFiles(inputFiles: string[]): void {
    if (!inputFiles.length) {
      throw new Error("No input files provided");
    }
    inputFiles.forEach((file, index) => {
      if (typeof file !== "string" || !file.trim()) {
        throw new Error(`Invalid input file at index ${index}: ${file}`);
      }
      if (!file.match(/\.(jpg|jpeg|png|webp)$/i)) {
        throw new Error(`Unsupported file format at index ${index}: ${file}`);
      }
    });
  }

  private async generateMapVideoForTemplate(
    coordinates: { lat: number; lng: number },
    jobId: string
  ): Promise<string | null> {
    try {
      // 🔹 Generate a cache key for this map video request
      const cacheKey = this.generateCacheKey({ type: "map", coordinates });

      // 🔹 Check if a cached map video exists
      const cached = await this.prisma.processedAsset.findFirst({
        where: {
          type: "map",
          cacheKey,
          createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // 24-hour cache
        },
      });

      if (cached) {
        logger.info(`[${jobId}] Using cached map video: ${cached.path}`);
        return cached.path;
      } else {
        logger.warn(
          `[${jobId}] No cached map video found, generating a new one.`
        );
      }

      // 🔹 Generate a new map video
      const mapVideo = await this.withRetry(
        () => mapCaptureService.generateMapVideo(coordinates, jobId),
        this.MAX_RETRIES
      );

      if (!mapVideo) {
        throw new Error("Map video generation failed");
      }

      await this.resourceManager.trackResource(mapVideo);

      // 🔹 Store the newly generated map video in cache
      await this.prisma.processedAsset.create({
        data: {
          type: "map",
          path: mapVideo,
          cacheKey,
          hash: require("crypto")
            .createHash("md5")
            .update(mapVideo)
            .digest("hex"),
          metadata: {
            coordinates,
            timestamp: Date.now(),
          },
        },
      });

      return mapVideo;
    } catch (error) {
      logger.error(`[${jobId}] Map video generation failed:`, error);
      return null;
    }
  }
}
