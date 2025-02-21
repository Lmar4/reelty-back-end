import {
  PrismaClient,
  VideoGenerationStatus,
  VideoJob,
  ProcessedAsset,
} from "@prisma/client";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { logger } from "../../utils/logger";
import { mapCaptureService } from "../map-capture/map-capture.service";
import { runwayService } from "../video/runway.service";
import { videoTemplateService } from "../video/video-template.service";
import { reelTemplates, TemplateKey } from "./templates/types";
import { videoProcessingService } from "../video/video-processing.service";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Prisma } from "@prisma/client";
import pLimit from "p-limit";
import crypto from "crypto";

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
  inputFiles: string[]; // S3 URLs like properties/${userId}/listings/${timestamp}-${file.name}.webp
  template: TemplateKey;
  coordinates?: { lat: number; lng: number };
  isRegeneration?: boolean;
  regenerationContext?: RegenerationContext;
  skipRunway?: boolean;
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
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly TEMP_DIRS = {
    OUTPUT: "temp/output",
  };

  private s3Client: S3Client;
  private resourceManager: ResourceManager;
  private limit: ReturnType<typeof pLimit>;

  constructor(private readonly prisma: PrismaClient = new PrismaClient()) {
    this.resourceManager = new ResourceManager();
    this.limit = pLimit(this.BATCH_SIZE);
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
    type: "runway" | "map"
  ): Promise<string | null> {
    const cachedAsset = await this.prisma.processedAsset.findUnique({
      where: { cacheKey },
    });

    if (!cachedAsset) return null;

    const age = Date.now() - cachedAsset.createdAt.getTime();
    if (age > this.CACHE_TTL_MS) {
      await this.prisma.processedAsset.delete({
        where: { id: cachedAsset.id },
      });
      return null;
    }

    try {
      await fs.access(cachedAsset.path);
      return cachedAsset.path;
    } catch (error) {
      logger.warn(`Cached asset missing or inaccessible: ${cachedAsset.path}`, {
        error,
      });
      await this.prisma.processedAsset.delete({
        where: { id: cachedAsset.id },
      });
      return null;
    }
  }

  private async cacheAsset(
    cacheKey: string,
    path: string,
    type: "runway" | "map"
  ): Promise<void> {
    const fileBuffer = await fs.readFile(path);
    const hash = crypto.createHash("md5").update(fileBuffer).digest("hex");

    await this.prisma.processedAsset.upsert({
      where: { cacheKey },
      update: { path, hash, updatedAt: new Date() },
      create: {
        type,
        path,
        cacheKey,
        hash,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
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

    if (isRegeneration && regenerationContext) {
      const { photosToRegenerate, existingPhotos, totalPhotos } =
        regenerationContext;
      const runwayVideos = new Array(totalPhotos).fill(null);

      const existingPromises = existingPhotos.map(async (photo) => {
        const cacheKey = `runway_${jobId}_${photo.order}_${crypto
          .createHash("md5")
          .update(photo.processedFilePath)
          .digest("hex")}`;
        const cachedPath = await this.getCachedAsset(cacheKey, "runway");

        if (cachedPath) {
          logger.info(`[${jobId}] Cache hit for existing runway video`, {
            cacheKey,
            path: cachedPath,
          });
          this.resourceManager.trackResource(cachedPath);
          return { order: photo.order, path: cachedPath };
        }

        const videoPath = await runwayService.generateVideo(
          photo.processedFilePath,
          photo.order,
          listingId,
          jobId
        );
        if (videoPath) {
          this.resourceManager.trackResource(videoPath);
          await this.cacheAsset(cacheKey, videoPath, "runway");
        }
        return { order: photo.order, path: videoPath };
      });

      const regeneratePromises = photosToRegenerate.map(async (photo) => {
        const cacheKey = `runway_${jobId}_${photo.order}_${crypto
          .createHash("md5")
          .update(photo.processedFilePath)
          .digest("hex")}`;
        const videoPath = await runwayService.generateVideo(
          photo.processedFilePath,
          photo.order,
          listingId,
          jobId
        );
        if (videoPath) {
          this.resourceManager.trackResource(videoPath);
          await this.cacheAsset(cacheKey, videoPath, "runway");
        }
        return { order: photo.order, path: videoPath };
      });

      const results = await Promise.all([
        ...existingPromises,
        ...regeneratePromises,
      ]);
      results.forEach(({ order, path }) => {
        if (path) runwayVideos[order] = path;
      });

      const validVideos = runwayVideos.filter((v): v is string => !!v);
      if (validVideos.length === 0)
        throw new Error("No videos generated from Runway during regeneration");
      return validVideos;
    }

    const runwayPromises = inputFiles.map(async (file, index) => {
      const cacheKey = `runway_${jobId}_${index}_${crypto
        .createHash("md5")
        .update(file)
        .digest("hex")}`;
      const cachedPath = await this.getCachedAsset(cacheKey, "runway");

      if (cachedPath) {
        logger.info(`[${jobId}] Cache hit for runway video`, {
          cacheKey,
          path: cachedPath,
        });
        this.resourceManager.trackResource(cachedPath);
        return cachedPath;
      }

      const videoPath = await runwayService.generateVideo(
        file,
        index,
        listingId,
        jobId
      );
      if (videoPath) {
        this.resourceManager.trackResource(videoPath);
        await this.cacheAsset(cacheKey, videoPath, "runway");
      }
      return videoPath;
    });

    const runwayVideos = await Promise.all(runwayPromises);
    const validVideos = runwayVideos.filter((v): v is string => !!v);
    if (validVideos.length === 0)
      throw new Error("No videos generated from Runway");
    return validVideos;
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
      if (!templateConfig) throw new Error(`Unknown template: ${template}`);
      if (runwayVideos.length < 1)
        throw new Error(`Template ${template} requires at least 1 video`);

      const requiresMap = templateConfig.sequence.includes("map");
      if (requiresMap && !mapVideo)
        throw new Error(`Template ${template} requires a map video`);

      const outputPath = this.getTempPath(
        "OUTPUT",
        `${template}_${Date.now()}_output.mp4`
      );
      const clips = await videoTemplateService.createTemplate(
        template,
        runwayVideos,
        mapVideo || undefined,
        { watermark: true }
      );

      await videoProcessingService.stitchVideos(
        clips.map((clip) => clip.path),
        clips.map((clip) => clip.duration),
        outputPath,
        templateConfig
      );

      const s3Key = `properties/${listingId}/videos/templates/${jobId}/${template}.mp4`;
      const s3Url = await this.uploadToS3(outputPath, s3Key);

      clips.forEach((clip) => this.resourceManager.trackResource(clip.path));
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

  private async processTemplates(
    runwayVideos: string[],
    jobId: string,
    listingId: string,
    coordinates?: { lat: number; lng: number }
  ): Promise<string[]> {
    const mapVideo = coordinates
      ? await this.generateMapVideoForTemplate(coordinates, jobId, listingId)
      : null;

    const templatePromises = ALL_TEMPLATES.map((template) =>
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

  async execute({
    jobId,
    inputFiles,
    template,
    coordinates,
    isRegeneration,
    regenerationContext,
    skipRunway,
  }: ProductionPipelineInput): Promise<string> {
    try {
      await this.updateJobProgress(jobId, {
        stage: "runway",
        progress: 0,
        message: "Starting pipeline",
      });

      const job = await this.prisma.videoJob.findUnique({
        where: { id: jobId },
        select: { userId: true, listingId: true },
      });
      if (!job || !job.listingId)
        throw new Error("Job not found or missing listingId");

      const { listingId } = job;

      let runwayVideos = inputFiles;
      if (!skipRunway) {
        runwayVideos = await this.processRunwayVideos(
          inputFiles,
          jobId,
          listingId,
          isRegeneration,
          regenerationContext
        );
      }

      await this.updateJobProgress(jobId, {
        stage: "template",
        progress: 50,
        message: "Processing templates",
      });
      const templateResults = await this.processTemplates(
        runwayVideos,
        jobId,
        listingId,
        coordinates
      );

      if (templateResults.length === 0)
        throw new Error("No templates processed successfully");

      await Promise.all(
        templateResults.map((outputPath, idx) =>
          this.prisma.videoJob.create({
            data: {
              userId: job.userId,
              listingId,
              status: VideoGenerationStatus.COMPLETED,
              progress: 100,
              template: ALL_TEMPLATES[idx],
              outputFile: outputPath,
              inputFiles,
              completedAt: new Date(),
            },
          })
        )
      );

      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: VideoGenerationStatus.COMPLETED,
          progress: 100,
          outputFile: templateResults[0],
          inputFiles,
          completedAt: new Date(),
          metadata: {
            defaultTemplate: template,
            processedTemplates: templateResults.map((path, idx) => ({
              key: ALL_TEMPLATES[idx],
              path,
            })),
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
        },
      });
      throw error;
    } finally {
      logger.info(`[${jobId}] Cleaning up all temporary files`);
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
    const fileStream = createReadStream(filePath);

    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: bucket,
        Key: s3Key,
        Body: fileStream,
        ContentType: "video/mp4",
      },
    });

    await upload.done();
    const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
    this.resourceManager.trackResource(filePath);
    return s3Url;
  }
}
