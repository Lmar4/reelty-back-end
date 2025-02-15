import {
  Listing,
  Photo,
  Prisma,
  PrismaClient,
  User,
  VideoGenerationStatus,
  VideoJob,
} from "@prisma/client";
import ffmpeg from "fluent-ffmpeg";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { AssetCacheService } from "../cache/assetCache";
import { runwayService } from "../video/runway.service";
import { s3VideoService } from "../video/s3-video.service";
import { videoProcessingService } from "../video/video-processing.service";
import { videoTemplateService } from "../video/video-template.service";
import { imageProcessor } from "./image.service";
import { MapCaptureService } from "../map-capture/map-capture.service";
import { TemplateKey, reelTemplates } from "./templates/types";
import { VisionProcessor } from "./visionProcessor";
import { logger } from "../../utils/logger";
import { s3Service } from "../storage/s3.service";

interface ProcessingStepSettings {
  width?: number;
  height?: number;
  quality?: number;
  template?: string;
  duration?: number;
  [key: string]: unknown;
}

interface CacheMetadata {
  timestamp: Date;
  settings: Record<string, unknown>;
  hash: string;
  index?: number;
  localPath?: string;
  dimensions?: { width: number; height: number };
  size?: number;
}

interface ProcessingStep {
  id: string;
  type: "webp" | "crop" | "runway" | "ffmpeg";
  input: string[];
  output: string[];
  settings: ProcessingStepSettings;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  metadata?: {
    cacheKey?: string;
    processingTime?: number;
    localPath?: string;
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
  coordinates?: {
    lat: number;
    lng: number;
  };
  _isRegeneration?: boolean;
}

type VideoJobWithRelations = VideoJob & {
  listing?:
    | (Listing & {
        user?: User;
        address: string;
      })
    | null;
};

type JobWithListingAndUser = VideoJob & {
  listing: Listing & {
    user: User;
    address: string;
  };
};

// Type guard for JobWithListingAndUser
function isJobWithListingAndUser(
  job: VideoJobWithRelations | null
): job is JobWithListingAndUser {
  return (
    !!job &&
    !!job.listing &&
    !!job.listing.user &&
    typeof job.listing.address === "string"
  );
}

// Type guard for Photo with processedFilePath
function isPhotoWithProcessedFile(
  photo: Photo
): photo is Photo & { processedFilePath: string } {
  return photo.processedFilePath !== null;
}

interface ProcessingPhoto {
  path: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

interface S3VideoService {
  // Define methods for S3 video operations
  parseS3Path(path: string): { bucket: string; key: string };
  getPublicUrl(bucket: string, key: string): string;
  uploadVideo(localPath: string, s3Path: string): Promise<string>;
  checkFileExists(bucket: string, key: string): Promise<boolean>;
  uploadFile(file: Buffer, s3Key: string): Promise<string>;
  downloadFile(bucket: string, key: string, localPath: string): Promise<void>;
}

type VideoJobUpdateInput = Prisma.VideoJobUpdateInput;

interface WebPResult {
  path: string | null;
  error?: string;
  metadata?: {
    dimensions?: { width: number; height: number };
    size?: number;
  };
}

/**
 * ProductionPipeline handles the end-to-end process of converting images to videos.
 * The pipeline consists of three main stages:
 * 1. WebP Processing: Convert images to WebP format
 * 2. Runway Processing: Generate videos from WebP images
 * 3. Template Processing: Create final videos using templates
 */
export class ProductionPipeline {
  private visionProcessor: VisionProcessor;
  private mapCapture: MapCaptureService;
  private prisma: PrismaClient;
  private assetCache: AssetCacheService;
  private readonly batchSize = 3;
  private readonly outputDir: string;

  constructor(outputDir: string = process.env.TEMP_OUTPUT_DIR || "./temp") {
    this.prisma = new PrismaClient();
    this.visionProcessor = new VisionProcessor();
    this.mapCapture = MapCaptureService.getInstance();
    this.assetCache = AssetCacheService.getInstance();
    this.outputDir = outputDir;
  }

  private generateCacheKey(
    type: string,
    input: string | string[],
    metadata?: Record<string, unknown>
  ): string {
    const inputHash = Array.isArray(input) ? input.join("|") : input;
    return `${type}:${inputHash}${
      metadata ? ":" + JSON.stringify(metadata) : ""
    }`;
  }

  /**
   * Updates the job status and progress in the database
   * @param jobId - The ID of the job to update
   * @param status - The new status
   * @param error - Optional error message
   * @param metadata - Optional metadata including stage and progress information
   */
  private async updateJobStatus(
    jobId: string,
    status: VideoGenerationStatus,
    error?: string,
    metadata?: {
      stage?: "webp" | "runway" | "template" | "final";
      currentFile?: number;
      totalFiles?: number;
      progress?: number;
    }
  ): Promise<void> {
    console.log("Updating job status:", { jobId, status, error, metadata });

    // Convert technical stage to user-friendly message
    let userMessage = "";
    if (metadata?.stage === "webp") {
      userMessage = "Processing your photos...";
    } else if (metadata?.stage === "runway") {
      userMessage = "Creating your reel...";
    } else if (metadata?.stage === "template") {
      userMessage = "Almost ready...";
    }

    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        error,
        metadata: metadata
          ? {
              ...metadata,
              error,
              userMessage,
              // Keep internal tracking for debugging
              internalStage: metadata.stage,
              internalProgress: metadata.progress,
            }
          : undefined,
        // For progress bar, simplify to 3 stages (33% each)
        progress:
          metadata?.stage === "webp"
            ? 33
            : metadata?.stage === "runway"
            ? 66
            : metadata?.stage === "template"
            ? 99
            : metadata?.progress || 0,
      },
    });
  }

  /**
   * Processes items in batches to control concurrency
   * @param items - Array of items to process
   * @param processor - Function to process each item
   * @param batchSize - Optional batch size (defaults to this.batchSize)
   */
  private async processBatch<T>(
    items: T[],
    processor: (
      item: T,
      index: number
    ) => Promise<{
      path: string | null;
      error?: string;
      metadata?: {
        dimensions?: { width: number; height: number };
        size?: number;
      };
    }>,
    batchSize: number = this.batchSize
  ): Promise<
    Array<{
      path: string | null;
      error?: string;
      metadata?: {
        dimensions?: { width: number; height: number };
        size?: number;
      };
    }>
  > {
    console.log("[BATCH_PROCESSING] Starting batch processing:", {
      totalItems: items.length,
      batchSize,
      totalBatches: Math.ceil(items.length / batchSize),
    });

    const results: Array<{
      path: string | null;
      error?: string;
      metadata?: {
        dimensions?: { width: number; height: number };
        size?: number;
      };
    }> = new Array(items.length).fill({ path: null });
    let completedBatches = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batchNumber = Math.floor(i / batchSize) + 1;
      const batch = items.slice(i, i + batchSize);
      console.log(`[BATCH_PROCESSING] Processing batch ${batchNumber}:`, {
        batchSize: batch.length,
        startIndex: i,
        endIndex: i + batch.length,
      });

      const batchPromises = batch.map(async (item, batchIndex) => {
        const index = i + batchIndex;
        try {
          console.log(
            `[BATCH_PROCESSING] Processing item ${index + 1}/${items.length}`
          );
          const result = await processor(item, index);
          results[index] = result;
          console.log(
            `[BATCH_PROCESSING] Item ${index + 1}/${items.length} completed:`,
            {
              success: true,
              path: result.path,
            }
          );
          return result;
        } catch (error) {
          console.error(
            `[BATCH_PROCESSING] Item ${index + 1}/${items.length} failed:`,
            {
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
          results[index] = {
            path: null,
            error: error instanceof Error ? error.message : "Unknown error",
          };
          return results[index];
        }
      });

      await Promise.all(batchPromises);
      completedBatches++;
      console.log(`[BATCH_PROCESSING] Batch ${batchNumber} completed:`, {
        completedBatches,
        totalBatches: Math.ceil(items.length / batchSize),
        successfulItems: results.filter((r) => r.path !== null).length,
        failedItems: results.filter((r) => r.error).length,
      });
    }

    console.log("[BATCH_PROCESSING] All batches completed:", {
      totalProcessed: results.length,
      successful: results.filter((r) => r.path !== null).length,
      failed: results.filter((r) => r.error).length,
      results: results.map((r, i) => ({
        index: i,
        success: !!r.path,
        error: r.error,
      })),
    });

    return results;
  }

  /**
   * Processes WebP images to videos using Runway
   * Uses AssetCacheService for caching
   * @param webpPaths - Array of WebP paths to process
   * @param jobId - The ID of the job
   */
  private async processRunwayVideos(
    webpPaths: Array<{ path: string | null; error?: string }>,
    jobId: string
  ): Promise<Array<{ path: string | null; error?: string }>> {
    const validPaths = webpPaths
      .map((item, index) => ({ ...item, index }))
      .filter((item) => item.path !== null);

    console.log(
      `[${jobId}] Starting Runway processing for ${validPaths.length} valid WebP files`
    );

    const processVideo = async (
      item: { path: string | null; index: number },
      batchIndex: number
    ) => {
      if (!item.path) throw new Error("Invalid WebP path");

      try {
        // Check cache first
        const cacheKey = this.assetCache.generateCacheKey("runway", {
          path: item.path,
          index: item.index,
        });

        const cachedVideo = await this.assetCache.getCachedAsset(cacheKey);
        if (cachedVideo) {
          console.log("Cache hit for video:", {
            path: item.path,
            cached: cachedVideo.path,
          });

          // Update progress even for cached videos
          await this.updateJobStatus(
            jobId,
            VideoGenerationStatus.PROCESSING,
            undefined,
            {
              stage: "runway",
              currentFile: batchIndex + 1,
              totalFiles: validPaths.length,
              progress: 33 + (batchIndex / validPaths.length) * 33,
            }
          );

          return { path: cachedVideo.path };
        }

        // Update progress before starting video generation
        await this.updateJobStatus(
          jobId,
          VideoGenerationStatus.PROCESSING,
          undefined,
          {
            stage: "runway",
            currentFile: batchIndex + 1,
            totalFiles: validPaths.length,
            progress: 33 + (batchIndex / validPaths.length) * 33,
          }
        );

        let publicUrl: string;
        const originalPath = item.path;

        // Handle local file paths (including temp WebP files)
        if (originalPath.startsWith("/") || originalPath.startsWith("temp/")) {
          // Read the local file
          const fileBuffer = await fsPromises.readFile(originalPath);

          // Generate a unique S3 key for this temp file
          const key = `temp/runway-inputs/${Date.now()}-${path.basename(
            originalPath
          )}`;

          // Upload to S3
          await s3Service.uploadFile(fileBuffer, key);

          // Get the public URL
          publicUrl = s3Service.getPublicUrl(key);

          console.log(`[${jobId}] Uploaded local WebP to S3:`, {
            originalPath,
            s3Key: key,
            publicUrl,
          });
        } else if (originalPath.startsWith("s3://")) {
          // Convert s3:// URL to public HTTPS URL
          const { key } = s3Service.parseUrl(originalPath);
          publicUrl = s3Service.getPublicUrl(key);
          console.log(`[${jobId}] Converted S3 URL to public URL:`, {
            s3Url: originalPath,
            publicUrl,
          });
        } else {
          // For HTTPS URLs, use s3Service to clean and parse
          try {
            const { key } = s3Service.parseUrl(originalPath);
            publicUrl = s3Service.getPublicUrl(key);
            console.log(`[${jobId}] Cleaned and parsed HTTPS URL:`, {
              originalUrl: originalPath,
              publicUrl,
            });
          } catch (error) {
            // If parsing fails, use the URL as is
            publicUrl = originalPath;
          }
        }

        // Generate video using the public URL
        console.log(
          `[${jobId}] Sending request to Runway with public URL:`,
          publicUrl
        );
        const videoPath = await runwayService.generateVideo(
          publicUrl,
          item.index
        );

        // Cache the result
        await this.assetCache.cacheAsset({
          type: "runway",
          path: videoPath,
          cacheKey,
          metadata: {
            timestamp: new Date(),
            settings: { index: item.index },
            hash: this.assetCache.generateHash(videoPath),
          },
        });

        console.log(
          `[${jobId}] Video ${batchIndex + 1}/${validPaths.length} completed:`,
          videoPath
        );
        return { path: videoPath };
      } catch (error) {
        console.error(`[${jobId}] Runway processing failed:`, {
          path: item.path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          path: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    };

    // Process videos in batches and wait for all to complete
    const results = await this.processBatch(validPaths, processVideo);

    // Verify all videos are processed before proceeding
    const completedVideos = results.filter((result) => result.path !== null);
    console.log(`[${jobId}] Runway processing completed:`, {
      totalProcessed: results.length,
      successfulVideos: completedVideos.length,
      failedVideos: results.length - completedVideos.length,
    });

    if (completedVideos.length === 0) {
      throw new Error("No videos were successfully processed by Runway");
    }

    return results;
  }

  /**
   * Creates final videos using templates
   * Uses AssetCacheService for caching
   * @param runwayVideos - Array of Runway video paths
   * @param jobId - The ID of the job
   * @param templateKeys - Array of template keys to process
   */
  private async processTemplates(
    runwayVideos: Array<{ path: string | null; error?: string }>,
    jobId: string,
    templateKeys: TemplateKey[] = [
      "storyteller",
      "crescendo",
      "wave",
      "googlezoomintro",
    ]
  ): Promise<Array<{ path: string | null; error?: string }>> {
    const validVideos = runwayVideos
      .filter((item) => item.path !== null)
      .map((item) => item.path) as string[];

    console.log(`[${jobId}] Starting template processing:`, {
      totalVideos: runwayVideos.length,
      validVideos: validVideos.length,
      videoList: validVideos,
      templates: templateKeys,
    });

    if (validVideos.length === 0) {
      console.error(
        `[${jobId}] No valid videos available for template processing`
      );
      throw new Error("No valid videos available for template processing");
    }

    const processTemplate = async (template: TemplateKey, index: number) => {
      try {
        // Check cache first using AssetCacheService
        const cacheKey = this.assetCache.generateCacheKey("template", {
          template,
          videos: validVideos,
          index,
        });

        const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
        if (cachedAsset) {
          console.log(`[${jobId}] Cache hit for template:`, {
            template,
            cached: cachedAsset.path,
          });
          return { path: cachedAsset.path };
        }

        console.log(`[${jobId}] Creating template ${template}:`, {
          templateIndex: index,
          videosAvailable: validVideos.length,
          startTime: new Date().toISOString(),
        });

        // Get job details for coordinates if needed
        let mapVideo: string | undefined;
        if (template === "googlezoomintro") {
          const job = await this.prisma.videoJob.findUnique({
            where: { id: jobId },
            include: {
              listing: true,
            },
          });

          if (job?.listing?.coordinates) {
            const coordinates =
              typeof job.listing.coordinates === "string"
                ? JSON.parse(job.listing.coordinates)
                : job.listing.coordinates;

            console.log(`[${jobId}] Generating map video for coordinates:`, {
              coordinates,
              template,
            });

            mapVideo = await MapCaptureService.getInstance().generateMapVideo(
              coordinates,
              jobId
            );

            console.log(`[${jobId}] Map video generated:`, {
              mapVideoPath: mapVideo,
              template,
            });
          }
        }

        const clips = await videoTemplateService.createTemplate(
          template,
          validVideos,
          mapVideo // Pass the map video if generated
        );

        console.log(`[${jobId}] Template clips created for ${template}:`, {
          clipCount: clips.length,
          clipPaths: clips.map((c) => c.path),
          durations: clips.map((c) => c.duration),
          hasMapVideo: !!mapVideo,
        });

        const outputPath = path.join(
          this.outputDir,
          `${template}-${Date.now()}-${index}.mp4`
        );

        // Get template configuration for audio
        const templateConfig = reelTemplates[template];
        console.log(`[${jobId}] Template configuration for ${template}:`, {
          template,
          musicConfig: templateConfig.music,
          hasValidMusic: templateConfig.music?.isValid,
          musicPath: templateConfig.music?.path,
          musicVolume: templateConfig.music?.volume,
        });

        // Process video with template configuration
        await videoProcessingService.stitchVideos(
          clips.map((clip) => clip.path),
          clips.map((clip) => clip.duration),
          outputPath,
          reelTemplates[template as TemplateKey] // Pass the full template configuration
        );

        console.log(
          `[${jobId}] Template processing complete for ${template}:`,
          {
            outputPath,
            endTime: new Date().toISOString(),
            template,
            hasAudio: !!templateConfig.music,
            hasMapVideo: !!mapVideo,
          }
        );

        // Cache the result
        await this.assetCache.cacheAsset({
          type: "template",
          path: outputPath,
          cacheKey,
          metadata: {
            timestamp: new Date(),
            settings: {
              template,
              index,
              hasAudio: !!templateConfig.music,
              musicConfig: templateConfig.music,
              hasMapVideo: !!mapVideo,
            },
            hash: this.assetCache.generateHash(outputPath),
          },
        });

        return { path: outputPath };
      } catch (error) {
        console.error(
          `[${jobId}] Template processing failed for ${template}:`,
          {
            error: error instanceof Error ? error.message : "Unknown error",
            template,
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
        return {
          path: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    };

    // Process templates one at a time for better debugging
    const results = await this.processBatch(templateKeys, processTemplate, 1);

    console.log(`[${jobId}] Template processing completed:`, {
      totalTemplates: templateKeys.length,
      successful: results.filter((r) => r.path !== null).length,
      failed: results.filter((r) => r.error).length,
      outputs: results.map((r, i) => ({
        template: templateKeys[i],
        path: r.path,
        error: r.error,
      })),
    });

    return results;
  }

  /**
   * Processes photos to WebP format with retry logic and validation
   * @param photos - Array of photos to process
   * @param jobId - The ID of the job
   */
  public async processPhotosWithRetry(
    photos: Array<{ path: string }>,
    jobId: string,
    maxRetries: number = 3
  ): Promise<Array<WebPResult>> {
    console.log(`[${jobId}] Starting WebP processing:`, {
      totalPhotos: photos.length,
    });

    const results = await this.processBatch(photos, async (photo, index) => {
      let retries = 0;
      while (retries < maxRetries) {
        try {
          // Update progress
          await this.updateJobStatus(
            jobId,
            VideoGenerationStatus.PROCESSING,
            undefined,
            {
              stage: "webp",
              currentFile: index + 1,
              totalFiles: photos.length,
            }
          );

          // Check cache first
          const cacheKey = this.assetCache.generateCacheKey("webp", {
            path: photo.path,
            index,
          });

          const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
          if (cachedAsset) {
            console.log(`[${jobId}] Cache hit for WebP:`, {
              photo: photo.path,
              cached: cachedAsset.path,
            });
            return { path: cachedAsset.path };
          }

          // Process the URL to get a clean S3 URL or download the file locally
          let inputPath: string;
          let cleanupPath: string | null = null;

          try {
            if (
              photo.path.startsWith("https://") &&
              photo.path.includes("reelty-prod-storage.s3")
            ) {
              // Extract the S3 key from the URL
              const url = new URL(photo.path);
              const pathParts = url.pathname.split("/");
              const key = pathParts.slice(1).join("/");

              // Download the file using s3Service
              const tempPath = path.join(
                this.outputDir,
                `temp-${Date.now()}-${path.basename(key)}`
              );

              const buffer = await s3Service.downloadFile(
                `s3://${process.env.AWS_BUCKET}/${key}`
              );
              await fsPromises.writeFile(tempPath, buffer);

              inputPath = tempPath;
              cleanupPath = tempPath;
            } else if (photo.path.startsWith("s3://")) {
              // Direct S3 path - download to temp file
              const tempPath = path.join(
                this.outputDir,
                `temp-${Date.now()}-${path.basename(photo.path)}`
              );
              const buffer = await s3Service.downloadFile(photo.path);
              await fsPromises.writeFile(tempPath, buffer);

              inputPath = tempPath;
              cleanupPath = tempPath;
            } else {
              // Local file or regular URL
              inputPath = photo.path;
            }

            console.log(
              `[${jobId}] Processing photo ${index + 1}/${photos.length}:`,
              {
                originalPath: photo.path,
                processedPath: inputPath,
                attempt: retries + 1,
              }
            );

            // Process photo to WebP using visionProcessor
            const webpPath = await this.visionProcessor.convertToWebP(
              inputPath,
              path.join(
                this.outputDir,
                `${path.basename(
                  inputPath,
                  path.extname(inputPath)
                )}-${Date.now()}.webp`
              ),
              {
                width: 768,
                height: 1280,
                quality: 90,
                fit: "cover",
              }
            );

            // Validate the WebP output
            const stats = await fsPromises.stat(webpPath);
            const metadata = {
              size: stats.size,
              dimensions: await this.visionProcessor.getImageDimensions(
                webpPath
              ),
            };

            // Validate dimensions and size
            if (
              metadata.dimensions.width !== 768 ||
              metadata.dimensions.height !== 1280
            ) {
              throw new Error(
                `Invalid WebP dimensions: ${JSON.stringify(
                  metadata.dimensions
                )}`
              );
            }

            if (metadata.size < 1000) {
              // Less than 1KB is suspicious
              throw new Error(`WebP file too small: ${metadata.size} bytes`);
            }

            // Clean up temp file if we created one
            if (cleanupPath) {
              await fsPromises.unlink(cleanupPath).catch(console.error);
            }

            // Cache the result
            await this.assetCache.cacheAsset({
              type: "webp",
              path: webpPath,
              cacheKey,
              metadata: {
                timestamp: new Date(),
                settings: { index },
                dimensions: metadata.dimensions,
                size: metadata.size,
                hash: this.assetCache.generateHash(webpPath),
              } as CacheMetadata,
            });

            console.log(
              `[${jobId}] WebP conversion complete ${index + 1}/${
                photos.length
              }:`,
              {
                input: photo.path,
                output: webpPath,
                metadata,
              }
            );

            return { path: webpPath, metadata };
          } catch (error) {
            // Clean up temp file if we created one and an error occurred
            if (cleanupPath) {
              await fsPromises.unlink(cleanupPath).catch(console.error);
            }
            throw error;
          }
        } catch (error) {
          retries++;
          console.error(
            `[${jobId}] WebP conversion failed (attempt ${retries}):`,
            {
              photo: photo.path,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );

          if (retries === maxRetries) {
            return {
              path: null,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
        }
      }

      return { path: null, error: "Max retries exceeded" };
    });

    console.log(`[${jobId}] WebP processing completed:`, {
      totalProcessed: photos.length,
      successful: results.filter((r) => r.path !== null).length,
      failed: results.filter((r) => r.error).length,
      results: results.map((r) => ({
        success: !!r.path,
        error: r.error,
        metadata: r.metadata,
      })),
    });

    return results;
  }

  async execute({
    jobId,
    inputFiles,
    template,
    coordinates,
    _isRegeneration = false,
  }: ProductionPipelineInput): Promise<string> {
    let job: JobWithListingAndUser | null = null;

    try {
      // Get job details
      const fetchedJob = (await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        include: {
          listing: {
            include: {
              user: true,
            },
          },
        },
      })) as VideoJobWithRelations;

      if (!isJobWithListingAndUser(fetchedJob)) {
        const errorDetails = {
          jobId,
          hasJob: !!fetchedJob,
          hasListing: !!fetchedJob?.listing,
          hasUser: !!fetchedJob?.listing?.user,
          hasAddress: typeof fetchedJob?.listing?.address === "string",
        };
        logger.error("Invalid job data", errorDetails);
        throw new Error(
          `Invalid job data for ${jobId}: ${JSON.stringify(errorDetails)}`
        );
      }

      job = fetchedJob;

      // Update job status to PROCESSING
      await this.updateJobStatus(jobId, VideoGenerationStatus.PROCESSING);

      logger.info(`[EXECUTE] Starting processing pipeline`, {
        jobId,
        totalInputFiles: inputFiles.length,
        template: template || "default",
        hasCoordinates: !!coordinates,
      });

      // Process WebP conversion for all images
      const webpResults = await this.processPhotosWithRetry(
        inputFiles.map((path) => ({ path })),
        jobId
      );

      // Validate WebP results
      const successfulWebPs = webpResults.filter((r) => r.path !== null);
      if (successfulWebPs.length === 0) {
        throw new Error("No WebP files were successfully generated");
      }

      // Process Runway videos
      const runwayResults = await this.processRunwayVideos(webpResults, jobId);

      // Process templates
      const templateResults = await this.processTemplates(
        runwayResults,
        jobId,
        ["googlezoomintro"]
      );

      // Get the successful templates
      const successfulTemplates = templateResults
        .filter((result) => result.path !== null)
        .map((result) => result.path) as string[];

      if (successfulTemplates.length === 0) {
        throw new Error("No templates were successfully generated");
      }

      // Update job as completed with the first successful template
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.COMPLETED,
          progress: 100,
          outputFile: successfulTemplates[0],
          completedAt: new Date(),
          error: null,
          metadata: {
            stage: "completed",
            templates: successfulTemplates,
            webpResults: webpResults.map((r) => ({
              success: !!r.path,
              path: r.path,
              error: r.error,
              metadata: r.metadata,
            })),
          },
        } as Prisma.VideoJobUpdateInput,
      });

      return successfulTemplates[0];
    } catch (error) {
      logger.error("[CREATE_JOB] Production pipeline error", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  async regeneratePhotos(jobId: string, photoIds: string[]): Promise<string> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      include: {
        listing: {
          include: {
            photos: {
              orderBy: {
                order: "asc",
              },
            },
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

      console.log(`[REGENERATE] Starting regeneration for photos:`, {
        jobId,
        photoIds,
        totalPhotos: job.listing.photos.length,
        photosToRegenerate: photoIds.length,
      });

      // Get all photos in order
      const allPhotos = job.listing.photos;
      const videoSegments: string[] = [];

      // Process each photo in sequence
      for (const photo of allPhotos) {
        try {
          let videoPath: string;

          if (photoIds.includes(photo.id)) {
            // Only process photos that need regeneration
            console.log(`[REGENERATE] Processing photo for regeneration:`, {
              photoId: photo.id,
              hasProcessedFile: !!photo.processedFilePath,
            });

            if (!photo.processedFilePath) {
              throw new Error(`Photo ${photo.id} has no processed file path`);
            }

            // Use the existing WebP file to generate new Runway video
            const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${photo.processedFilePath}`;
            const { bucket, key } = s3VideoService.parseS3Path(s3WebpPath);
            const publicUrl = s3VideoService.getPublicUrl(bucket, key);

            // Check cache first
            const cacheKey = this.assetCache.generateCacheKey("runway", {
              path: publicUrl,
              index: allPhotos.indexOf(photo),
            });

            const cachedVideo = await this.assetCache.getCachedAsset(cacheKey);
            if (cachedVideo) {
              console.log(`[REGENERATE] Cache hit for video:`, {
                photoId: photo.id,
                cached: cachedVideo.path,
              });
              videoPath = cachedVideo.path;
            } else {
              // Generate new video only if not in cache
              console.log(`[REGENERATE] Generating new video for photo:`, {
                photoId: photo.id,
                webpUrl: publicUrl,
              });

              videoPath = await runwayService.generateVideo(
                publicUrl,
                allPhotos.indexOf(photo)
              );

              // Cache the result
              await this.assetCache.cacheAsset({
                type: "runway",
                path: videoPath,
                cacheKey,
                metadata: {
                  timestamp: new Date(),
                  settings: { index: allPhotos.indexOf(photo) },
                  hash: this.assetCache.generateHash(videoPath),
                },
              });
            }

            // Update the photo's runway video path
            await this.prisma.photo.update({
              where: { id: photo.id },
              data: {
                runwayVideoPath: videoPath,
                status: "completed",
                error: null,
              },
            });
          } else {
            // Reuse existing video for photos that don't need regeneration
            if (!photo.runwayVideoPath) {
              throw new Error(`Photo ${photo.id} has no runway video path`);
            }
            console.log(`[REGENERATE] Reusing existing video for photo:`, {
              photoId: photo.id,
              videoPath: photo.runwayVideoPath,
            });
            videoPath = photo.runwayVideoPath;
          }

          videoSegments.push(videoPath);
        } catch (error) {
          console.error(`[REGENERATE] Failed to process photo:`, {
            photoId: photo.id,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      }

      if (!job.template) {
        throw new Error("Job template is required");
      }

      console.log(`[REGENERATE] Creating template with video segments:`, {
        template: job.template,
        segmentCount: videoSegments.length,
      });

      // Create clips configuration
      let clips;
      const coordinates = job.listing.coordinates
        ? typeof job.listing.coordinates === "string"
          ? JSON.parse(job.listing.coordinates)
          : job.listing.coordinates
        : undefined;

      if (job.template === "default") {
        job.template = "googlezoomintro";
      }

      if (job.template === "googlezoomintro" && coordinates) {
        // Generate map video
        const mapVideo = await MapCaptureService.getInstance().generateMapVideo(
          coordinates,
          jobId
        );
        clips = await videoTemplateService.createTemplate(
          job.template as TemplateKey,
          videoSegments,
          mapVideo
        );
      } else {
        clips = await videoTemplateService.createTemplate(
          job.template as TemplateKey,
          videoSegments
        );
      }

      // Create a new final video
      const outputPath = path.join(
        process.env.TEMP_OUTPUT_DIR || "./temp",
        `${job.template}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}.mp4`
      );

      await videoProcessingService.stitchVideos(
        clips.map((clip) => clip.path),
        clips.map((clip) => clip.duration),
        outputPath,
        reelTemplates[job.template as TemplateKey] // Pass the full template configuration
      );

      // Upload the new video to S3
      const s3Key = `videos/${path.basename(outputPath)}`;
      const s3Url = await s3VideoService.uploadVideo(
        outputPath,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      // Generate thumbnail using ffmpeg
      const thumbnailPath = path.join(
        process.env.TEMP_OUTPUT_DIR || "./temp",
        `thumbnail-${path.basename(outputPath, ".mp4")}.jpg`
      );

      await new Promise((resolve, reject) => {
        ffmpeg(outputPath)
          .screenshots({
            timestamps: ["1"],
            filename: path.basename(thumbnailPath),
            folder: path.dirname(thumbnailPath),
            size: "720x1280",
          })
          .on("end", resolve)
          .on("error", reject);
      });

      // Upload thumbnail to S3
      const thumbnailS3Key = `thumbnails/${path.basename(thumbnailPath)}`;
      const thumbnailBuffer = await fsPromises.readFile(thumbnailPath);
      const thumbnailS3Url = await s3VideoService.uploadFile(
        thumbnailBuffer,
        thumbnailS3Key
      );

      // Store all generated templates in metadata
      const successfulTemplates = clips
        .map((clip, i) => ({
          template: ["storyteller", "crescendo", "wave", "googlezoomintro"][i],
          path: clip.path,
        }))
        .filter((t) => t.path !== null);

      // Update job with S3 URLs and metadata
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          outputFile: s3Url,
          thumbnailUrl: thumbnailS3Url,
          status: VideoGenerationStatus.COMPLETED,
          completedAt: new Date(),
          metadata: {
            ...((job.metadata as Record<string, any>) || {}),
            endTime: new Date().toISOString(),
            generatedTemplates: successfulTemplates,
            selectedTemplate: job.template,
            regeneratedPhotos: photoIds,
          },
        } as Prisma.VideoJobUpdateInput,
      });

      // Clean up temporary files
      await fsPromises.unlink(thumbnailPath);
      await fsPromises.unlink(outputPath);

      return s3Url;
    } catch (error) {
      console.error(`[REGENERATE] Job failed:`, {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Update job as failed
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.FAILED,
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });

      throw error;
    }
  }

  async regeneratePhotosOptimized(
    jobId: string,
    photoIds: string[]
  ): Promise<string> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      include: {
        listing: {
          include: {
            photos: {
              orderBy: {
                order: "asc",
              },
            },
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

      console.log(`[REGENERATE_OPTIMIZED] Starting regeneration:`, {
        jobId,
        photoIds,
        totalPhotos: job.listing.photos.length,
        photosToRegenerate: photoIds.length,
      });

      // Get all photos in order
      const allPhotos = job.listing.photos;
      const videoSegments: string[] = [];

      // Extract coordinates from listing for map video
      const coordinates = job.listing.coordinates
        ? typeof job.listing.coordinates === "string"
          ? JSON.parse(job.listing.coordinates)
          : job.listing.coordinates
        : undefined;

      if (job.template === "default") {
        job.template = "googlezoomintro";
      }

      // First, process photos that need regeneration
      for (const photoId of photoIds) {
        const photo = allPhotos.find((p) => p.id === photoId);
        if (!photo) {
          console.error(`[REGENERATE_OPTIMIZED] Photo not found:`, { photoId });
          continue;
        }

        console.log(
          `[REGENERATE_OPTIMIZED] Processing photo for regeneration:`,
          {
            photoId,
            hasProcessedFile: !!photo.processedFilePath,
            hasRunwayVideo: !!photo.runwayVideoPath,
          }
        );

        // Verify we have the WebP file
        if (!photo.processedFilePath) {
          throw new Error(`Photo ${photo.id} has no processed WebP file path`);
        }

        // Use the existing WebP file to generate new Runway video
        const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${photo.processedFilePath}`;
        const { bucket, key } = s3VideoService.parseS3Path(s3WebpPath);
        const publicUrl = s3VideoService.getPublicUrl(bucket, key);

        // Check cache first
        const cacheKey = this.assetCache.generateCacheKey("runway", {
          path: publicUrl,
          index: allPhotos.indexOf(photo),
        });

        let videoPath: string;
        const cachedVideo = await this.assetCache.getCachedAsset(cacheKey);
        if (cachedVideo) {
          console.log(`[REGENERATE_OPTIMIZED] Cache hit for video:`, {
            photoId,
            cached: cachedVideo.path,
          });
          videoPath = cachedVideo.path;
        } else {
          // Generate new video using existing WebP
          videoPath = await runwayService.generateVideo(
            publicUrl,
            allPhotos.indexOf(photo)
          );

          // Cache the result
          await this.assetCache.cacheAsset({
            type: "runway",
            path: videoPath,
            cacheKey,
            metadata: {
              timestamp: new Date(),
              settings: { index: allPhotos.indexOf(photo) },
              hash: this.assetCache.generateHash(videoPath),
            },
          });
        }

        // Update the photo's runway video path
        await this.prisma.photo.update({
          where: { id: photo.id },
          data: {
            runwayVideoPath: videoPath,
            status: "completed",
            error: null,
          },
        });
      }

      // Now collect all video segments in order
      for (const photo of allPhotos) {
        if (!photo.runwayVideoPath) {
          throw new Error(`Photo ${photo.id} has no runway video path`);
        }
        videoSegments.push(photo.runwayVideoPath);
      }

      if (!job.template) {
        throw new Error("Job template is required");
      }

      console.log(`[REGENERATE_OPTIMIZED] Creating template:`, {
        template: job.template,
        segmentCount: videoSegments.length,
        hasCoordinates: !!coordinates,
      });

      // Create clips configuration with map video if needed
      let clips;
      if (job.template === "googlezoomintro" && coordinates) {
        // Generate map video
        const mapVideo = await MapCaptureService.getInstance().generateMapVideo(
          coordinates,
          jobId
        );
        clips = await videoTemplateService.createTemplate(
          job.template as TemplateKey,
          videoSegments,
          mapVideo
        );
      } else {
        clips = await videoTemplateService.createTemplate(
          job.template as TemplateKey,
          videoSegments
        );
      }

      // Create a new final video
      const outputPath = path.join(
        process.env.TEMP_OUTPUT_DIR || "./temp",
        `${job.template}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}.mp4`
      );

      await videoProcessingService.stitchVideos(
        clips.map((clip) => clip.path),
        clips.map((clip) => clip.duration),
        outputPath,
        reelTemplates[job.template as TemplateKey] // Pass the full template configuration
      );

      // Upload the new video to S3
      const s3Key = `videos/${path.basename(outputPath)}`;
      const s3Url = await s3VideoService.uploadVideo(
        outputPath,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      // Generate thumbnail
      const thumbnailPath = path.join(
        process.env.TEMP_OUTPUT_DIR || "./temp",
        `thumbnail-${path.basename(outputPath, ".mp4")}.jpg`
      );

      await new Promise((resolve, reject) => {
        ffmpeg(outputPath)
          .screenshots({
            timestamps: ["1"],
            filename: path.basename(thumbnailPath),
            folder: path.dirname(thumbnailPath),
            size: "720x1280",
          })
          .on("end", resolve)
          .on("error", reject);
      });

      // Upload thumbnail to S3
      const thumbnailS3Key = `thumbnails/${path.basename(thumbnailPath)}`;
      const thumbnailBuffer = await fsPromises.readFile(thumbnailPath);
      const thumbnailS3Url = await s3VideoService.uploadFile(
        thumbnailBuffer,
        thumbnailS3Key
      );

      // Update job with new video URL
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          outputFile: s3Url,
          thumbnailUrl: thumbnailS3Url,
          status: VideoGenerationStatus.COMPLETED,
          error: null,
          completedAt: new Date(),
        } as Prisma.VideoJobUpdateInput,
      });

      // Clean up temporary files
      await fsPromises.unlink(thumbnailPath);
      await fsPromises.unlink(outputPath);

      return s3Url;
    } catch (error) {
      console.error(`[REGENERATE_OPTIMIZED] Job failed:`, {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Update job as failed
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.FAILED,
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });

      throw error;
    }
  }
}
