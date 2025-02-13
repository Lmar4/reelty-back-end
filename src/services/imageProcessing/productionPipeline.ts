import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import * as path from "path";
import { prisma } from "../../lib/prisma";
import { imageProcessor } from "./image.service";
import { MapCapture } from "./mapCapture";
import { TemplateKey } from "./templates/types";
import { VisionProcessor } from "./visionProcessor";
import { runwayService } from "../video/runway.service";
import { videoProcessingService } from "../video/video-processing.service";
import { s3VideoService } from "../video/s3-video.service";
import { videoTemplateService } from "../video/video-template.service";
import * as fs from "fs/promises";
import { AssetCacheService } from "../cache/assetCache";

interface ProcessingStep {
  id: string;
  type: "webp" | "crop" | "runway" | "ffmpeg";
  input: string[];
  output: string[];
  settings: any;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  metadata?: {
    cacheKey?: string;
    processingTime?: number;
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
  coordinates?: { lat: number; lng: number };
  isRegeneration?: boolean;
}

interface S3VideoService {
  parseS3Path(path: string): { bucket: string; key: string };
  getPublicUrl(bucket: string, key: string): string;
  uploadVideo(localPath: string, s3Path: string): Promise<string>;
  checkFileExists(bucket: string, key: string): Promise<boolean>;
}

export class ProductionPipeline {
  private visionProcessor: VisionProcessor;
  private mapCapture: MapCapture;
  private processingSteps: Map<string, ProcessingStep>;
  private prisma: PrismaClient;
  private assetCache: AssetCacheService;
  private readonly batchSize = 3;
  private readonly processingLocks = new Map<string, Promise<any>>();

  constructor() {
    this.prisma = new PrismaClient();
    this.visionProcessor = new VisionProcessor();
    this.mapCapture = new MapCapture(process.env.TEMP_OUTPUT_DIR || "./temp");
    this.processingSteps = new Map();
    this.assetCache = AssetCacheService.getInstance();
  }

  private async withProcessingLock<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // Wait for any existing operation with the same key
    const existingLock = this.processingLocks.get(key);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock
    const operationPromise = operation();
    this.processingLocks.set(key, operationPromise);

    try {
      const result = await operationPromise;
      return result;
    } finally {
      // Clean up lock after operation completes or fails
      this.processingLocks.delete(key);
    }
  }

  private generateCacheKey(
    type: string,
    input: string | string[],
    metadata?: any
  ): string {
    const inputHash = Array.isArray(input) ? input.join("|") : input;
    return `${type}:${inputHash}${
      metadata ? ":" + JSON.stringify(metadata) : ""
    }`;
  }

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

    await prisma.videoJob.update({
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

  private async processWebP(
    jobId: string,
    input: string[],
    isRegeneration: boolean = false
  ): Promise<ProcessingStep> {
    await this.updateJobStatus(
      jobId,
      VideoGenerationStatus.PROCESSING,
      undefined,
      {
        stage: "webp",
        currentFile: 0,
        totalFiles: input.length,
        progress: 0,
      }
    );

    const step: ProcessingStep = {
      id: `webp-${Date.now()}`,
      type: "webp",
      input,
      output: [],
      settings: {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
      },
      status: "processing",
    };

    try {
      const results = await Promise.all(
        input.map(async (url, index) => {
          const cacheKey = this.generateCacheKey("webp", url, step.settings);

          return await this.withProcessingLock(cacheKey, async () => {
            try {
              // Check cache first
              const cachedAsset = await this.assetCache.getCachedAsset(
                cacheKey
              );
              if (cachedAsset) {
                console.log("Cache hit for WebP:", { url, cachedAsset });
                await this.updateJobStatus(
                  jobId,
                  VideoGenerationStatus.PROCESSING,
                  undefined,
                  {
                    stage: "webp",
                    currentFile: index + 1,
                    totalFiles: input.length,
                    progress: Math.round(((index + 1) / input.length) * 25),
                  }
                );
                return cachedAsset.path;
              }

              let inputUrl = url;
              if (url.includes("s3.") || url.startsWith("s3://")) {
                const { bucket, key } = s3VideoService.parseS3Path(url);
                const exists = await s3VideoService.checkFileExists(
                  bucket,
                  key
                );
                if (!exists) {
                  throw new Error(`S3 file not found: ${bucket}/${key}`);
                }
                inputUrl = s3VideoService.getPublicUrl(bucket, key);
              } else {
                await fs.access(url);
              }

              const result = await imageProcessor.processImage(inputUrl);

              // Cache the result
              await this.assetCache.cacheAsset({
                type: "webp",
                path: result.s3WebpPath,
                cacheKey,
                metadata: {
                  ...step.settings,
                  timestamp: new Date(),
                  hash: this.assetCache.generateHash(result.s3WebpPath),
                },
              });

              await this.updateJobStatus(
                jobId,
                VideoGenerationStatus.PROCESSING,
                undefined,
                {
                  stage: "webp",
                  currentFile: index + 1,
                  totalFiles: input.length,
                  progress: Math.round(((index + 1) / input.length) * 25),
                }
              );

              return result.s3WebpPath;
            } catch (error) {
              console.error(`Failed to process image ${index + 1}:`, error);
              throw error;
            }
          });
        })
      );

      step.output = results;
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
      console.error("WebP processing failed:", {
        error: step.error,
        input,
        jobId,
        isRegeneration,
      });

      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        `WebP processing failed: ${step.error}`
      );
    }

    this.processingSteps.set(step.id, step);
    return step;
  }

  private async getCachedRunwayVideo(
    imageUrl: string,
    index: number
  ): Promise<string | null> {
    const cacheKey = this.generateCacheKey("runway", imageUrl, { index });
    const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
    return cachedAsset?.path || null;
  }

  private async cacheRunwayVideo(
    imageUrl: string,
    videoPath: string,
    index: number
  ): Promise<void> {
    const cacheKey = this.generateCacheKey("runway", imageUrl, { index });
    await this.assetCache.cacheAsset({
      type: "runway",
      path: videoPath,
      cacheKey,
      metadata: {
        timestamp: new Date(),
        settings: { index },
        hash: this.generateCacheKey("runway", imageUrl, { index }),
      },
    });
  }

  private async getCachedTemplate(
    template: string,
    inputVideos: string[],
    mapVideoPath?: string
  ): Promise<string | null> {
    const settings = {
      template,
      inputs: inputVideos,
      mapVideo: mapVideoPath,
    };
    const cacheKey = this.generateCacheKey("ffmpeg", template, settings);
    const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
    return cachedAsset?.path || null;
  }

  private async cacheTemplate(
    template: string,
    outputPath: string,
    inputVideos: string[],
    mapVideoPath?: string
  ): Promise<void> {
    const settings = {
      template,
      inputs: inputVideos,
      mapVideo: mapVideoPath,
    };
    const cacheKey = this.generateCacheKey("ffmpeg", template, settings);
    await this.assetCache.cacheAsset({
      type: "ffmpeg",
      path: outputPath,
      cacheKey,
      metadata: {
        timestamp: new Date(),
        settings,
        hash: this.generateCacheKey("ffmpeg", template, settings),
      },
    });
  }

  private async processRunway(
    jobId: string,
    input: string[]
  ): Promise<ProcessingStep> {
    await this.updateJobStatus(
      jobId,
      VideoGenerationStatus.PROCESSING,
      undefined,
      {
        stage: "runway",
        currentFile: 0,
        totalFiles: input.length,
        progress: 25,
      }
    );

    const step: ProcessingStep = {
      id: `runway-${Date.now()}`,
      type: "runway",
      input,
      output: [],
      settings: {},
      status: "processing",
    };

    try {
      const batches = [];
      for (let i = 0; i < input.length; i += this.batchSize) {
        const batch = input.slice(i, i + this.batchSize);
        batches.push(batch);
      }

      const results: string[] = [];

      for (const [batchIndex, batch] of batches.entries()) {
        const batchPromises = batch.map(async (imageUrl, index) => {
          const absoluteIndex = batchIndex * this.batchSize + index;
          const cacheKey = this.generateCacheKey("runway", imageUrl, {
            index: absoluteIndex,
          });

          return await this.withProcessingLock(cacheKey, async () => {
            try {
              // Check cache first
              const cachedAsset = await this.assetCache.getCachedAsset(
                cacheKey
              );
              if (cachedAsset) {
                console.log("Cache hit for runway video:", {
                  imageUrl,
                  cachedAsset,
                });
                return cachedAsset.path;
              }

              const videoPath = await runwayService.generateVideo(
                imageUrl,
                absoluteIndex
              );

              // Cache the result
              await this.assetCache.cacheAsset({
                type: "runway",
                path: videoPath,
                cacheKey,
                metadata: {
                  timestamp: new Date(),
                  settings: { index: absoluteIndex },
                  hash: this.generateCacheKey("runway", imageUrl, {
                    index: absoluteIndex,
                  }),
                },
              });

              await this.updateJobStatus(
                jobId,
                VideoGenerationStatus.PROCESSING,
                undefined,
                {
                  stage: "runway",
                  currentFile: absoluteIndex + 1,
                  totalFiles: input.length,
                  progress: Math.min(
                    25 + Math.floor(((absoluteIndex + 1) / input.length) * 40),
                    65
                  ),
                }
              );

              return videoPath;
            } catch (error) {
              console.error("Video generation failed:", {
                imageUrl,
                index: absoluteIndex,
                error: error instanceof Error ? error.message : "Unknown error",
              });
              throw error;
            }
          });
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }

      step.output = results;
      step.status = "completed";
    } catch (error) {
      console.error("Runway processing failed:", error);
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
      throw error;
    }

    this.processingSteps.set(step.id, step);
    return step;
  }

  private async processTemplates(
    jobId: string,
    input: string[],
    templates: string[],
    mapVideoPath?: string
  ): Promise<ProcessingStep> {
    await this.updateJobStatus(
      jobId,
      VideoGenerationStatus.PROCESSING,
      undefined,
      {
        stage: "template",
        currentFile: 0,
        totalFiles: templates.length,
        progress: 75,
      }
    );

    const step: ProcessingStep = {
      id: `templates-${Date.now()}`,
      type: "ffmpeg",
      input,
      output: [],
      settings: { templates },
      status: "processing",
    };

    try {
      const results = await Promise.all(
        templates.map(async (template, index) => {
          // Check cache first
          const cachedTemplate = await this.getCachedTemplate(
            template,
            input,
            mapVideoPath
          );
          if (cachedTemplate) {
            console.log("Cache hit for template:", {
              template,
              cachedTemplate,
            });
            return cachedTemplate;
          }

          const clips = await videoTemplateService.createTemplate(
            template.toLowerCase().replace(/\s+/g, "_") as TemplateKey,
            input,
            mapVideoPath
          );

          const outputPath = path.join(
            process.env.TEMP_OUTPUT_DIR || "./temp",
            `${template}-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 7)}.mp4`
          );

          await videoProcessingService.stitchVideos(
            clips.map((clip) => clip.path),
            clips.map((clip) => clip.duration),
            outputPath
          );

          // Cache the result
          await this.cacheTemplate(template, outputPath, input, mapVideoPath);

          await this.updateJobStatus(
            jobId,
            VideoGenerationStatus.PROCESSING,
            undefined,
            {
              stage: "template",
              currentFile: index + 1,
              totalFiles: templates.length,
              progress: Math.round(75 + ((index + 1) / templates.length) * 25),
            }
          );

          return outputPath;
        })
      );

      step.output = results;
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
    }

    this.processingSteps.set(step.id, step);
    return step;
  }

  async execute({
    jobId,
    inputFiles,
    template,
    coordinates,
    isRegeneration = false,
  }: ProductionPipelineInput): Promise<string> {
    try {
      // Get job details
      const job = await prisma.videoJob.findUnique({
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

      // Get all templates
      const allTemplates = await prisma.template.findMany({
        orderBy: { order: "asc" },
      });

      // Process WebP conversion or download existing WebPs if regenerating
      const webpStep = await this.processWebP(
        jobId,
        inputFiles,
        isRegeneration
      );
      if (webpStep.status === "failed") {
        throw new Error(`WebP processing failed: ${webpStep.error}`);
      }

      // Process map video if needed
      let mapVideoPath: string | undefined;
      if (template === "googlezoomintro") {
        if (!coordinates) {
          throw new Error(
            "Coordinates are required for Google Maps zoom template"
          );
        }

        if (!process.env.GOOGLE_MAPS_API_KEY) {
          throw new Error("Google Maps API key is not configured");
        }

        try {
          const mapFrames = await this.mapCapture.captureMapAnimation(
            job.listing.address,
            coordinates
          );

          if (!mapFrames || mapFrames.length === 0) {
            throw new Error("Failed to generate map frames");
          }

          mapVideoPath = mapFrames[0];
          console.log("Successfully generated map video:", mapVideoPath);
        } catch (error) {
          throw new Error(
            `Failed to generate map video: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      // Process Runway videos
      const runwayStep = await this.processRunway(jobId, webpStep.output);
      if (runwayStep.status === "failed") {
        throw new Error(`Runway processing failed: ${runwayStep.error}`);
      }

      // Process all templates
      const templateStep = await this.processTemplates(
        jobId,
        runwayStep.output,
        allTemplates.map((t) => t.name),
        mapVideoPath
      );

      if (templateStep.status === "failed") {
        throw new Error(`Template processing failed: ${templateStep.error}`);
      }

      // Upload final video to S3
      const outputFile = templateStep.output[0]; // Use the first template output as main output
      const s3Key = `videos/${path.basename(outputFile)}`;
      const s3Url = await s3VideoService.uploadVideo(
        outputFile,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      // Update job with S3 URL
      await prisma.videoJob.update({
        where: { id: jobId },
        data: { outputFile: s3Url, status: "COMPLETED" },
      });

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
    const job = await prisma.videoJob.findUnique({
      where: { id: jobId },
      include: {
        listing: {
          include: {
            photos: true,
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

      // Process each photo
      const regeneratedVideos = await Promise.all(
        photoIds.map(async (photoId, index) => {
          const photo = job.listing?.photos.find((p) => p.id === photoId);
          if (!photo || !photo.processedFilePath) {
            throw new Error(`Invalid photo data for ${photoId}`);
          }

          const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${photo.processedFilePath}`;
          const { bucket, key } = s3VideoService.parseS3Path(s3WebpPath);
          const publicUrl = s3VideoService.getPublicUrl(bucket, key);

          return await runwayService.generateVideo(publicUrl, index);
        })
      );

      // Get all video segments (both regenerated and existing)
      const allPhotos = job.listing.photos;
      const videoSegments = allPhotos
        .map((photo) => {
          const regeneratedIndex = photoIds.indexOf(photo.id);
          if (regeneratedIndex !== -1) {
            return regeneratedVideos[regeneratedIndex];
          }
          return photo.runwayVideoPath || null;
        })
        .filter(Boolean) as string[];

      if (!job.template) {
        throw new Error("Job template is required");
      }

      // Create clips configuration
      const clips = await videoTemplateService.createTemplate(
        job.template as TemplateKey,
        videoSegments
      );

      // Create a new final video with the updated segments
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

      // Update job with new video URL
      await prisma.videoJob.update({
        where: { id: jobId },
        data: {
          outputFile: s3Url,
          status: VideoGenerationStatus.COMPLETED,
          error: null,
        },
      });
    } catch (error) {
      console.error("Error during photo regeneration:", error);
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        error instanceof Error
          ? error.message
          : "Unknown error during regeneration"
      );
      throw error;
    }
  }
}
