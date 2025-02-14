import {
  Listing,
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
import { MapCapture } from "./mapCapture";
import { TemplateKey } from "./templates/types";
import { VisionProcessor } from "./visionProcessor";

interface ProcessingStepSettings {
  width?: number;
  height?: number;
  quality?: number;
  template?: string;
  duration?: number;
  [key: string]: unknown;
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
  _isRegeneration?: boolean; // Prefixed with _ to indicate it's intentionally unused
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
}

type VideoJobUpdateInput = Prisma.VideoJobUpdateInput;

/**
 * ProductionPipeline handles the end-to-end process of converting images to videos.
 * The pipeline consists of three main stages:
 * 1. WebP Processing: Convert images to WebP format
 * 2. Runway Processing: Generate videos from WebP images
 * 3. Template Processing: Create final videos using templates
 */
export class ProductionPipeline {
  private visionProcessor: VisionProcessor;
  private mapCapture: MapCapture;
  private prisma: PrismaClient;
  private assetCache: AssetCacheService;
  private readonly batchSize = 3;
  private readonly outputDir: string;

  constructor(outputDir: string = process.env.TEMP_OUTPUT_DIR || "./temp") {
    this.prisma = new PrismaClient();
    this.visionProcessor = new VisionProcessor();
    this.mapCapture = new MapCapture(process.env.TEMP_OUTPUT_DIR || "./temp");
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
    ) => Promise<{ path: string | null; error?: string }>,
    batchSize: number = this.batchSize
  ): Promise<Array<{ path: string | null; error?: string }>> {
    console.log("[BATCH_PROCESSING] Starting batch processing:", {
      totalItems: items.length,
      batchSize,
      totalBatches: Math.ceil(items.length / batchSize),
    });

    const results: Array<{ path: string | null; error?: string }> = new Array(
      items.length
    ).fill({ path: null });
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
   * Processes photos to WebP format with retry logic
   * Uses AssetCacheService for caching
   * @param photos - Array of photos to process
   * @param jobId - The ID of the job
   */
  private async processPhotosWithRetry(
    photos: ProcessingPhoto[],
    jobId: string
  ): Promise<Array<{ path: string | null; error?: string }>> {
    console.log(
      `[${jobId}] Starting WebP processing for ${photos.length} photos`
    );

    const results = await this.processBatch(photos, async (photo, index) => {
      try {
        const inputPath = photo.path;
        console.log(
          `[${jobId}] Processing WebP ${index + 1}/${photos.length}:`,
          {
            path: inputPath,
            cached: false,
          }
        );

        // Check cache first using AssetCacheService
        const cacheKey = this.assetCache.generateCacheKey("webp", {
          path: inputPath,
          index,
        });

        const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
        if (cachedAsset) {
          console.log(`[${jobId}] Cache hit for WebP:`, {
            path: inputPath,
            cached: cachedAsset.path,
          });
          return { path: cachedAsset.path };
        }

        const processedImage = await imageProcessor.processImage(inputPath);
        await processedImage.uploadPromise;

        // Cache the result
        await this.assetCache.cacheAsset({
          type: "webp",
          path: processedImage.s3WebpPath,
          cacheKey,
          metadata: {
            timestamp: new Date(),
            settings: { index },
            hash: this.assetCache.generateHash(processedImage.s3WebpPath),
          },
        });

        console.log(
          `[${jobId}] WebP processing complete ${index + 1}/${photos.length}:`,
          {
            path: inputPath,
            output: processedImage.s3WebpPath,
          }
        );

        return { path: processedImage.s3WebpPath };
      } catch (error) {
        console.error(
          `[${jobId}] WebP processing failed ${index + 1}/${photos.length}:`,
          {
            path: photo.path,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );
        return {
          path: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    console.log(`[${jobId}] WebP processing completed:`, {
      total: photos.length,
      successful: results.filter((r) => r.path !== null).length,
      failed: results.filter((r) => r.error).length,
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
    const validPaths = webpPaths.filter((item) => item.path !== null);

    console.log(`[${jobId}] Starting Runway processing:`, {
      totalWebPs: webpPaths.length,
      validWebPs: validPaths.length,
      invalidWebPs: webpPaths.length - validPaths.length,
    });

    const results = await this.processBatch(validPaths, async (item, index) => {
      if (!item.path) return { path: null, error: "Invalid WebP path" };

      try {
        // Check cache first using AssetCacheService
        const cacheKey = this.assetCache.generateCacheKey("runway", {
          path: item.path,
          index,
        });

        const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
        if (cachedAsset) {
          console.log(`[${jobId}] Cache hit for Runway video:`, {
            webp: item.path,
            cached: cachedAsset.path,
          });
          return { path: cachedAsset.path };
        }

        console.log(
          `[${jobId}] Processing Runway video ${index + 1}/${
            validPaths.length
          }:`,
          {
            webpPath: item.path,
            startTime: new Date().toISOString(),
          }
        );

        const videoPath = await runwayService.generateVideo(item.path, index);

        // Cache the result
        await this.assetCache.cacheAsset({
          type: "runway",
          path: videoPath,
          cacheKey,
          metadata: {
            timestamp: new Date(),
            settings: { index },
            hash: this.assetCache.generateHash(videoPath),
          },
        });

        console.log(
          `[${jobId}] Runway processing complete ${index + 1}/${
            validPaths.length
          }:`,
          {
            webpPath: item.path,
            videoPath: videoPath,
            endTime: new Date().toISOString(),
          }
        );

        return { path: videoPath };
      } catch (error) {
        console.error(
          `[${jobId}] Runway processing failed ${index + 1}/${
            validPaths.length
          }:`,
          {
            webpPath: item.path,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );
        return {
          path: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    console.log(`[${jobId}] Runway processing completed:`, {
      totalProcessed: validPaths.length,
      successful: results.filter((r) => r.path !== null).length,
      failed: results.filter((r) => r.error).length,
      videos: results.map((r) => r.path).filter(Boolean),
    });

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

        const clips = await videoTemplateService.createTemplate(
          template,
          validVideos
        );

        console.log(`[${jobId}] Template clips created for ${template}:`, {
          clipCount: clips.length,
          clipPaths: clips.map((c) => c.path),
          durations: clips.map((c) => c.duration),
        });

        const outputPath = path.join(
          this.outputDir,
          `${template}-${Date.now()}-${index}.mp4`
        );
        await videoProcessingService.stitchVideos(
          clips.map((clip) => clip.path),
          clips.map((clip) => clip.duration),
          outputPath
        );

        console.log(
          `[${jobId}] Template processing complete for ${template}:`,
          {
            outputPath,
            endTime: new Date().toISOString(),
          }
        );

        return { path: outputPath };
      } catch (error) {
        console.error(
          `[${jobId}] Template processing failed for ${template}:`,
          {
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );
        return {
          path: null,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    };

    const results = await this.processBatch(templateKeys, processTemplate, 2);

    console.log(`[${jobId}] Template processing completed:`, {
      totalTemplates: templateKeys.length,
      successful: results.filter((r) => r.path !== null).length,
      failed: results.filter((r) => r.error).length,
      outputs: results.map((r) => r.path).filter(Boolean),
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
    let job:
      | (VideoJob & {
          listing: Listing & {
            user: User;
          };
        })
      | null = null;

    try {
      // Get job details
      job = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        include: {
          listing: {
            include: {
              user: true,
            },
          },
        },
      });

      if (!job || !job.listing || !job.listing.user || !job.listing.address) {
        throw new Error(`Invalid job data for ${jobId}`);
      }

      // Update job status to PROCESSING
      await this.updateJobStatus(jobId, VideoGenerationStatus.PROCESSING);

      // Get all templates
      const allTemplates = await this.prisma.template.findMany({
        orderBy: { order: "asc" },
      });

      console.log(`[EXECUTE] Starting processing pipeline for job ${jobId}:`, {
        totalInputFiles: inputFiles.length,
        template,
        hasCoordinates: !!coordinates,
      });

      // Process WebP conversion for all images
      console.log(`[EXECUTE] Starting WebP processing stage`);
      const webpResults = await this.processPhotosWithRetry(
        inputFiles.map((path) => ({ path })),
        jobId
      );

      // Validate WebP results
      const validWebpResults = webpResults.filter(
        (result) => result.path !== null
      );
      console.log(`[EXECUTE] WebP processing stage completed:`, {
        totalProcessed: webpResults.length,
        successful: validWebpResults.length,
        failed: webpResults.length - validWebpResults.length,
      });

      if (validWebpResults.length === 0) {
        throw new Error(
          "WebP processing failed: No valid WebP files were generated"
        );
      }

      if (validWebpResults.length < inputFiles.length) {
        console.warn(`[EXECUTE] Some WebP conversions failed:`, {
          expected: inputFiles.length,
          successful: validWebpResults.length,
          failed: webpResults.filter((r) => r.error).map((r) => r.error),
        });
      }

      // Process Runway videos for all WebP files
      console.log(`[EXECUTE] Starting Runway processing stage`);
      const runwayResults = await this.processRunwayVideos(
        validWebpResults,
        jobId
      );

      // Validate Runway results
      const validRunwayResults = runwayResults.filter(
        (result) => result.path !== null
      );
      console.log(`[EXECUTE] Runway processing stage completed:`, {
        totalProcessed: runwayResults.length,
        successful: validRunwayResults.length,
        failed: runwayResults.length - validRunwayResults.length,
      });

      if (validRunwayResults.length === 0) {
        throw new Error(
          "Runway processing failed: No valid videos were generated"
        );
      }

      if (validRunwayResults.length < validWebpResults.length) {
        console.warn(`[EXECUTE] Some Runway conversions failed:`, {
          expected: validWebpResults.length,
          successful: validRunwayResults.length,
          failed: runwayResults.filter((r) => r.error).map((r) => r.error),
        });
      }

      // Process all templates
      console.log(`[EXECUTE] Starting template processing stage`);
      const templateResults = await this.processTemplates(
        validRunwayResults,
        jobId,
        allTemplates.map((t) => t.name as TemplateKey)
      );

      // Validate template results
      const validTemplateResults = templateResults.filter(
        (result) => result.path !== null
      );
      console.log(`[EXECUTE] Template processing stage completed:`, {
        totalProcessed: templateResults.length,
        successful: validTemplateResults.length,
        failed: templateResults.length - validTemplateResults.length,
      });

      if (validTemplateResults.length === 0) {
        throw new Error(
          "Template processing failed: No valid templates were generated"
        );
      }

      // Get the first valid template result
      const outputFile = validTemplateResults[0].path;
      if (!outputFile) {
        throw new Error("No valid output file found from template processing");
      }

      // Upload final video to S3
      const s3Key = `videos/${path.basename(outputFile)}`;
      const s3Url = await s3VideoService.uploadVideo(
        outputFile,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      // Generate thumbnail using ffmpeg
      const thumbnailPath = path.join(
        process.env.TEMP_OUTPUT_DIR || "./temp",
        `thumbnail-${path.basename(outputFile, ".mp4")}.jpg`
      );

      await new Promise((resolve, reject) => {
        ffmpeg(outputFile)
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
          },
        } as Prisma.VideoJobUpdateInput,
      });

      // Clean up temporary files
      await fsPromises.unlink(thumbnailPath);

      return s3Url;
    } catch (error) {
      console.error("[CREATE_JOB] Production pipeline error:", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  async regeneratePhotos(jobId: string, photoIds: string[]): Promise<void> {
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
      });

      // Get all photos in order
      const allPhotos = job.listing.photos;
      const videoSegments: string[] = [];

      // Process each photo in sequence
      for (const photo of allPhotos) {
        try {
          let videoPath: string;

          if (photoIds.includes(photo.id)) {
            // This photo needs regeneration
            console.log(`[REGENERATE] Processing photo for regeneration:`, {
              photoId: photo.id,
              hasProcessedFile: !!photo.processedFilePath,
            });

            if (!photo.processedFilePath) {
              throw new Error(`Photo ${photo.id} has no processed file path`);
            }

            const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${photo.processedFilePath}`;
            const { bucket, key } = s3VideoService.parseS3Path(s3WebpPath);
            const publicUrl = s3VideoService.getPublicUrl(bucket, key);

            // Generate new video for this photo
            videoPath = await runwayService.generateVideo(
              publicUrl,
              allPhotos.indexOf(photo)
            );

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
            // Reuse existing video if available
            if (!photo.runwayVideoPath) {
              console.log(`[REGENERATE] Generating missing video for photo:`, {
                photoId: photo.id,
                hasProcessedFile: !!photo.processedFilePath,
              });

              if (!photo.processedFilePath) {
                throw new Error(`Photo ${photo.id} has no processed file path`);
              }

              const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${photo.processedFilePath}`;
              const { bucket, key } = s3VideoService.parseS3Path(s3WebpPath);
              const publicUrl = s3VideoService.getPublicUrl(bucket, key);

              videoPath = await runwayService.generateVideo(
                publicUrl,
                allPhotos.indexOf(photo)
              );

              // Update the photo's runway video path
              await this.prisma.photo.update({
                where: { id: photo.id },
                data: { runwayVideoPath: videoPath },
              });
            } else {
              console.log(`[REGENERATE] Reusing existing video for photo:`, {
                photoId: photo.id,
                videoPath: photo.runwayVideoPath,
              });
              videoPath = photo.runwayVideoPath;
            }
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
      const clips = await videoTemplateService.createTemplate(
        job.template as TemplateKey,
        videoSegments
      );

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
        outputPath
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
}
