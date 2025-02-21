import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import { RunwayClient } from "../runway";
import { runwayService } from "../video/runway.service";
import { s3VideoService } from "../video/s3-video.service";
import { videoProcessingService } from "../video/video-processing.service";
import { videoTemplateService } from "../video/video-template.service";
import { imageProcessor } from "./image.service";
import { TemplateKey } from "./templates/types";
import { reelTemplates } from "./templates/types";
import { AssetCacheService } from "../cache/assetCache";
import { s3Service } from "../storage/s3.service";
import { ProductionPipeline } from "./__productionPipeline";
import { MapCaptureService } from "../map-capture/map-capture.service";

const prisma = new PrismaClient();

// Add ProcessedImage type
export interface ProcessedImage {
  croppedPath: string;
  s3WebpPath: string;
  uploadPromise: Promise<void>;
}

export interface VideoClip {
  path: string;
  duration: number;
}

export interface VideoTemplate {
  duration: 5 | 10; // Only 5 or 10 seconds allowed
  ratio?: "1280:768" | "768:1280"; // Only these aspect ratios allowed
  watermark?: boolean; // Optional watermark flag
  templateKey?: TemplateKey; // Template to use for video generation
  headers?: {
    [key: string]: string;
  };
}

export type AssetType = "webp" | "runway" | "ffmpeg" | "map" | "template";

interface VideoMetadata {
  timestamp: Date;
  settings: {
    index: number;
    originalUrl: string;
    s3Key?: string;
  };
  hash: string;
}

interface Photo {
  id: string;
  listingId: string;
  userId: string;
  processedFilePath: string | null;
  listing: {
    id: string;
    [key: string]: unknown;
  } | null;
}

/**
 * ImageToVideoConverter handles the conversion of images to videos.
 * This class provides a high-level interface for the video generation pipeline.
 */
export class ImageToVideoConverter {
  private static instance: ImageToVideoConverter;
  private runwayClient: RunwayClient;
  private outputDir: string;
  private apiKey: string;
  private assetCache: AssetCacheService;
  private readonly BATCH_SIZE = 5;
  private readonly MAX_RETRIES = 3;

  private constructor(apiKey: string, outputDir: string = "./output") {
    if (!apiKey) {
      throw new Error("RunwayML API key is required");
    }
    this.runwayClient = new RunwayClient(apiKey);
    this.outputDir = outputDir;
    this.apiKey = apiKey;
    this.assetCache = AssetCacheService.getInstance();
  }

  public static getInstance(
    apiKey: string = process.env.RUNWAYML_API_KEY || ""
  ): ImageToVideoConverter {
    if (!ImageToVideoConverter.instance) {
      ImageToVideoConverter.instance = new ImageToVideoConverter(apiKey);
    }
    return ImageToVideoConverter.instance;
  }

  /**
   * Ensures a directory exists, creating it if necessary
   * @param dir - Directory path to check/create
   */
  private async ensureDirectoryExists(dir: string): Promise<void> {
    if (
      !(await fs.promises
        .access(dir)
        .then(() => true)
        .catch(() => false))
    ) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  private async generateRunwayVideo(
    imageUrl: string,
    index: number,
    listingId: string,
    jobId: string
  ): Promise<string> {
    try {
      console.log("Starting video generation:", { imageUrl, index });

      let publicUrl: string;

      // Handle local file paths (including temp WebP files)
      if (imageUrl.startsWith("/") || imageUrl.startsWith("temp/")) {
        // Read the local file
        const fileBuffer = await fs.promises.readFile(imageUrl);

        // Generate a unique S3 key for this temp file
        const key = `temp/runway-inputs/${Date.now()}-${path.basename(
          imageUrl
        )}`;

        // Upload to S3
        await s3Service.uploadFile(fileBuffer, key);

        // Get the public URL
        publicUrl = s3Service.getPublicUrl(key);

        console.log("Uploaded local WebP to S3:", {
          originalPath: imageUrl,
          s3Key: key,
          publicUrl,
        });
      } else if (imageUrl.startsWith("s3://")) {
        // Convert s3:// URL to public HTTPS URL
        const { key } = s3Service.parseUrl(imageUrl);
        publicUrl = s3Service.getPublicUrl(key);
        console.log("Converted S3 URL to public URL:", {
          s3Url: imageUrl,
          publicUrl,
        });
      } else {
        // For HTTPS URLs, use s3Service to clean and parse
        try {
          const { key } = s3Service.parseUrl(imageUrl);
          publicUrl = s3Service.getPublicUrl(key);
          console.log("Cleaned and parsed HTTPS URL:", {
            originalUrl: imageUrl,
            publicUrl,
          });
        } catch (error) {
          // If parsing fails, use the URL as is
          publicUrl = imageUrl;
        }
      }

      console.log("Sending request to Runway with public URL:", publicUrl);
      return await runwayService.generateVideo(publicUrl, index, listingId, jobId);
    } catch (error) {
      console.error("Generation failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        imageUrl,
        index,
      });
      throw new Error(
        `Failed to generate video: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private cleanS3Url(url: string): string {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.origin + parsedUrl.pathname;
    } catch (_error) {
      console.error("Failed to clean S3 URL:", { url });
      return url;
    }
  }

  private async getCachedVideo(
    imageUrl: string,
    index: number
  ): Promise<string | null> {
    let cacheKey: string;

    try {
      // Use s3Service to clean and parse the URL
      const { key } = s3Service.parseUrl(imageUrl);
      cacheKey = this.assetCache.generateCacheKey("runway", { index, key });
    } catch (error) {
      // If parsing fails, use the original URL
      cacheKey = this.assetCache.generateCacheKey("runway", {
        index,
        url: imageUrl,
      });
    }

    const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
    return cachedAsset?.path || null;
  }

  private async cacheVideo(
    imageUrl: string,
    videoPath: string,
    index: number
  ): Promise<void> {
    let cacheKey: string;
    let metadata: VideoMetadata = {
      timestamp: new Date(),
      settings: { index, originalUrl: imageUrl },
      hash: "",
    };

    try {
      const { key } = s3Service.parseUrl(imageUrl);
      cacheKey = this.assetCache.generateCacheKey("runway", { index, key });
      metadata.settings.s3Key = key;
    } catch (_error) {
      cacheKey = this.assetCache.generateCacheKey("runway", {
        index,
        url: imageUrl,
      });
    }

    await this.assetCache.cacheAsset({
      type: "runway",
      path: videoPath,
      cacheKey,
      metadata,
    });
  }

  async regenerateVideos(
    photoIds: string[]
  ): Promise<Array<{ id: string; listingId: string }>> {
    // Get photos that need regeneration
    const photos = await prisma.photo.findMany({
      where: {
        id: { in: photoIds },
        processedFilePath: { not: null },
      },
      include: {
        listing: true,
      },
    });

    if (photos.length === 0) {
      throw new Error("No valid photos found for regeneration");
    }

    // Group photos by listing
    const photosByListing = photos.reduce<
      Record<
        string,
        { listing: NonNullable<Photo["listing"]>; photos: Photo[] }
      >
    >((acc, photo) => {
      if (!photo.listing) return acc;
      if (!acc[photo.listingId]) {
        acc[photo.listingId] = {
          listing: photo.listing,
          photos: [],
        };
      }
      acc[photo.listingId].photos.push(photo);
      return acc;
    }, {});

    const jobs: Array<{ id: string; listingId: string }> = [];

    // Process each listing's photos
    for (const { listing, photos } of Object.values(photosByListing)) {
      try {
        // Create a new job for this listing
        const job = await prisma.videoJob.create({
          data: {
            userId: photos[0].userId,
            listingId: listing.id,
            status: VideoGenerationStatus.PROCESSING,
            template: "default",
            inputFiles: photos.map((p) => p.processedFilePath),
          },
        });

        jobs.push({ id: job.id, listingId: job.listingId });

        // Update photos status to processing
        await prisma.photo.updateMany({
          where: { id: { in: photos.map((p) => p.id) } },
          data: { status: VideoGenerationStatus.PROCESSING, error: null },
        });

        // Use ProductionPipeline to regenerate the specific photos
        const pipeline = new ProductionPipeline();
        await pipeline.regeneratePhotos(
          job.id,
          photos.map((p) => p.id)
        );
      } catch (error) {
        console.error("Failed to create job for listing:", {
          listingId: listing.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return jobs;
  }

  /**
   * Processes items in batches to control concurrency
   * @param items - Array of items to process
   * @param processor - Function to process each item
   * @param batchSize - Optional batch size (defaults to this.BATCH_SIZE)
   */
  private async processBatch<T>(
    items: T[],
    processor: (item: T, index: number) => Promise<string>,
    batchSize: number = this.BATCH_SIZE
  ): Promise<Array<{ path: string | null; error?: string }>> {
    const results: Array<{ path: string | null; error?: string }> = new Array(
      items.length
    ).fill({ path: null });

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchPromises = batch.map(async (item, batchIndex) => {
        const index = i + batchIndex;
        try {
          const result = await processor(item, index);
          results[index] = { path: result };
          return result;
        } catch (error) {
          results[index] = {
            path: null,
            error: error instanceof Error ? error.message : "Unknown error",
          };
          return null;
        }
      });

      await Promise.all(batchPromises);
    }

    return results;
  }

  /**
   * Processes photos to WebP format with retry logic
   * Uses AssetCacheService for caching
   * @param photos - Array of photos to process
   * @param jobId - The ID of the job
   */
  private async processPhotosWithRetry(
    photos: any[],
    jobId: string
  ): Promise<Array<{ path: string | null; error?: string }>> {
    const processPhoto = async (photo: any, index: number) => {
      let attempts = 0;
      let lastError: Error | null = null;

      while (attempts < this.MAX_RETRIES) {
        try {
          // Update progress
          await prisma.videoJob.update({
            where: { id: jobId },
            data: {
              progress: (index / photos.length) * 33,
              metadata: {
                stage: "webp",
                currentFile: index + 1,
                totalFiles: photos.length,
              },
            },
          });

          const inputPath = photo.url || photo.path;

          // Check cache first
          const cacheKey = this.assetCache.generateCacheKey("webp", {
            path: inputPath,
            index,
          });

          const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
          if (cachedAsset) {
            console.log("Cache hit for WebP:", {
              input: inputPath,
              cached: cachedAsset.path,
            });
            return cachedAsset.path;
          }

          // Process the photo
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

          return processedImage.s3WebpPath;
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error("Unknown error");
          attempts++;
          if (attempts < this.MAX_RETRIES) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * attempts)
            );
          }
        }
      }

      throw lastError;
    };

    return this.processBatch(photos, processPhoto);
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
        await prisma.videoJob.update({
          where: { id: jobId },
          data: {
            progress: 33 + (batchIndex / validPaths.length) * 33,
            metadata: {
              stage: "runway",
              currentFile: batchIndex + 1,
              totalFiles: validPaths.length,
            },
          },
        });

        return cachedVideo.path;
      }

      // Update progress before starting video generation
      await prisma.videoJob.update({
        where: { id: jobId },
        data: {
          progress: 33 + (batchIndex / validPaths.length) * 33,
          metadata: {
            stage: "runway",
            currentFile: batchIndex + 1,
            totalFiles: validPaths.length,
          },
        },
      });

      // Generate video
      console.log(
        `[${jobId}] Generating video ${batchIndex + 1}/${validPaths.length}:`,
        item.path
      );
      const videoPath = await this.generateRunwayVideo(item.path, item.index, "", "");

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
      return videoPath;
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
   * @param templates - Array of template keys to process
   */
  private async processTemplates(
    runwayVideos: Array<{ path: string | null; error?: string }>,
    jobId: string,
    templates: TemplateKey[] = [
      "storyteller",
      "crescendo",
      "wave",
      "googlezoomintro",
    ]
  ): Promise<Array<{ path: string | null; error?: string }>> {
    const validVideos = runwayVideos
      .filter((item) => item.path !== null)
      .map((item) => item.path) as string[];

    if (validVideos.length === 0) {
      throw new Error("No valid videos available for template processing");
    }

    console.log("[TEMPLATE_PROCESSING] Starting template processing:", {
      jobId,
      templates,
      validVideoCount: validVideos.length,
      validVideoPaths: validVideos,
    });

    const processTemplate = async (template: TemplateKey, index: number) => {
      // Check cache first
      const cacheKey = this.assetCache.generateCacheKey("template", {
        template,
        videos: validVideos,
        index,
      });

      const cachedTemplate = await this.assetCache.getCachedAsset(cacheKey);
      if (cachedTemplate) {
        console.log("Cache hit for template:", {
          template,
          cached: cachedTemplate.path,
        });
        return cachedTemplate.path;
      }

      console.log(`[TEMPLATE_PROCESSING] Processing template ${template}:`, {
        jobId,
        templateIndex: index,
        videoCount: validVideos.length,
      });

      // Update progress
      await prisma.videoJob.update({
        where: { id: jobId },
        data: {
          progress: 66 + (index / templates.length) * 34,
          metadata: {
            stage: "template",
            currentFile: index + 1,
            totalFiles: templates.length,
          },
        },
      });

      // Create template and get output path
      console.log(`[TEMPLATE_PROCESSING] Creating template ${template}...`);

      // Handle map video for googlezoomintro template
      let mapVideo: string | undefined;
      if (reelTemplates[template].sequence.includes("map")) {
        const job = await prisma.videoJob.findUnique({
          where: { id: jobId },
          include: { listing: true },
        });
        if (job?.listing?.coordinates) {
          const coordinates =
            typeof job.listing.coordinates === "string"
              ? JSON.parse(job.listing.coordinates)
              : job.listing.coordinates;
          console.log(
            `[TEMPLATE_PROCESSING] Generating map video for coordinates:`,
            {
              coordinates,
              template,
            }
          );
          mapVideo = await MapCaptureService.getInstance().generateMapVideo(
            coordinates,
            jobId
          );
          console.log(`[TEMPLATE_PROCESSING] Map video generated:`, {
            mapVideoPath: mapVideo,
            template,
          });
        }
      }

      const clips = await videoTemplateService.createTemplate(
        template,
        validVideos,
        mapVideo
      );
      console.log(`[TEMPLATE_PROCESSING] Template clips created:`, {
        template,
        clipCount: clips.length,
        clipPaths: clips.map((c) => c.path),
      });

      const outputPath = path.join(
        this.outputDir,
        `${template}-${Date.now()}-${index}.mp4`
      );

      // Log music configuration
      const templateConfig = reelTemplates[template];
      console.log(`[TEMPLATE_PROCESSING] Template music configuration:`, {
        template,
        musicConfig: templateConfig.music,
      });

      // Stitch videos and return path
      console.log(
        `[TEMPLATE_PROCESSING] Starting video stitching for ${template}`
      );
      await videoProcessingService.stitchVideos(
        clips.map((clip) => clip.path),
        clips.map((clip) => clip.duration),
        outputPath,
        templateConfig
      );

      // Cache the result
      await this.assetCache.cacheAsset({
        type: "template",
        path: outputPath,
        cacheKey,
        metadata: {
          timestamp: new Date(),
          settings: { template, index },
          hash: this.assetCache.generateHash(outputPath),
        },
      });

      console.log(`[TEMPLATE_PROCESSING] Video stitching completed:`, {
        template,
        outputPath,
      });

      return outputPath;
    };

    console.log(
      `[TEMPLATE_PROCESSING] Processing ${templates.length} templates with batch size 2`
    );
    return this.processBatch(templates, processTemplate, 2);
  }

  private async processPhotosForJob(
    jobId: string,
    photos: any[]
  ): Promise<void> {
    try {
      // Update job as started
      await prisma.videoJob.update({
        where: { id: jobId },
        data: { startedAt: new Date() },
      });

      // 1. Process photos to WebP
      console.log(
        `[${jobId}] Starting WebP processing for ${photos.length} photos`
      );
      const webpResults = await this.processPhotosWithRetry(photos, jobId);

      // 2. Generate videos using Runway
      console.log(
        `[${jobId}] Starting Runway processing for ${webpResults.length} WebPs`
      );
      const runwayResults = await this.processRunwayVideos(webpResults, jobId);

      // 3. Create templates
      console.log(`[${jobId}] Starting template generation`);
      const templateResults = await this.processTemplates(runwayResults, jobId);

      // Get the successful templates
      const successfulTemplates = templateResults
        .filter((result) => result.path !== null)
        .map((result) => result.path) as string[];

      if (successfulTemplates.length === 0) {
        throw new Error("No templates were successfully generated");
      }

      // Update job as completed with the first successful template
      await prisma.videoJob.update({
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
          },
        },
      });
    } catch (error) {
      console.error(`[${jobId}] Job failed:`, error);
      // Update job as failed
      await prisma.videoJob.update({
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

  async convertImagesToVideo(
    inputFiles: string[],
    template: VideoTemplate
  ): Promise<string> {
    try {
      const outputDir = this.outputDir;
      await this.ensureDirectoryExists(outputDir);

      const outputFile = path.join(
        outputDir,
        `${Date.now()}-${path.basename(inputFiles[0])}.mp4`
      );

      // Check cache first
      const cachedVideo = await this.getCachedVideo(inputFiles[0], 0);
      if (cachedVideo) {
        console.log("Cache hit for video:", {
          input: inputFiles[0],
          cachedVideo,
        });
        return cachedVideo;
      }

      // Process all images in parallel with batching
      const processedImages = await Promise.all(
        inputFiles.map(async (inputFile) => {
          // Process the image using imageProcessor service
          const processedImage = await imageProcessor.processImage(inputFile);
          // Wait for the WebP upload to complete
          await processedImage.uploadPromise;
          return processedImage.s3WebpPath;
        })
      );

      console.log(`Processed ${processedImages.length} images to WebP`);

      // Generate videos for all processed images
      const runwayVideos = await Promise.all(
        processedImages.map(async (s3WebpPath, index) => {
          const { bucket, key } = s3VideoService.parseS3Path(s3WebpPath);
          const publicUrl = s3VideoService.getPublicUrl(key, bucket);

          console.log("Using public URL for Runway:", publicUrl);

          const videoPath = await this.generateRunwayVideo(publicUrl, index, "", "");
          await this.cacheVideo(s3WebpPath, videoPath, index);

          console.log("Video created successfully:", videoPath);
          return videoPath;
        })
      );

      console.log(`Generated ${runwayVideos.length} videos`);

      // Create final video using template
      // Get clips configuration from template service
      const templateKey = template.templateKey || "storyteller";
      const clips = await videoTemplateService.createTemplate(
        templateKey,
        runwayVideos
      );

      // Use video processing service to stitch videos
      await videoProcessingService.stitchVideos(
        clips.map((clip) => clip.path),
        clips.map((clip) => clip.duration),
        outputFile,
        reelTemplates[templateKey]
      );

      console.log("Final video created at:", outputFile);
      return outputFile;
    } catch (error: unknown) {
      throw new Error(
        `Failed to convert images to video: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  async createTemplate(
    templateKey: TemplateKey,
    inputVideos: string[],
    mapVideoPath?: string
  ): Promise<string> {
    const outputPath = path.join(
      this.outputDir,
      `${templateKey}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}.mp4`
    );

    // Get clips configuration from template service
    const clips = await videoTemplateService.createTemplate(
      templateKey,
      inputVideos,
      mapVideoPath
    );

    // Use video processing service to stitch videos
    await videoProcessingService.stitchVideos(
      clips.map((clip) => clip.path),
      clips.map((clip) => clip.duration),
      outputPath
    );

    console.log(`${templateKey} video created at: ${outputPath}`);
    return outputPath;
  }
}

// Export singleton instance
export const imageToVideoConverter = ImageToVideoConverter.getInstance();
