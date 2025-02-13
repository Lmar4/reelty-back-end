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

export class ProductionPipeline {
  private visionProcessor: VisionProcessor;
  private mapCapture: MapCapture;
  private processingSteps: Map<string, ProcessingStep>;
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
    this.visionProcessor = new VisionProcessor();
    this.mapCapture = new MapCapture(process.env.TEMP_OUTPUT_DIR || "./temp");
    this.processingSteps = new Map();
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
        input.map(async (file, index) => {
          const result = await imageProcessor.processImage(file);
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
          return result;
        })
      );

      step.output = results.map(
        (result: { s3WebpPath: string }) => result.s3WebpPath
      );
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
      console.error("WebP processing failed:", {
        error: step.error,
        input,
      });
    }

    this.processingSteps.set(step.id, step);
    return step;
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
      settings: {
        duration: 5,
        ratio: "768:1280",
        watermark: false,
      },
      status: "processing",
    };

    try {
      const results = [];
      for (let i = 0; i < input.length; i++) {
        try {
          if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }

          const { bucket, key } = s3VideoService.parseS3Path(input[i]);
          const publicUrl = s3VideoService.getPublicUrl(bucket, key);
          const result = await runwayService.generateVideo(publicUrl, i);
          results.push(result);

          await this.updateJobStatus(
            jobId,
            VideoGenerationStatus.PROCESSING,
            undefined,
            {
              stage: "runway",
              currentFile: i + 1,
              totalFiles: input.length,
              progress: Math.round(25 + ((i + 1) / input.length) * 50),
            }
          );

          console.log(`Successfully processed video ${i + 1}/${input.length}`);
        } catch (error) {
          console.error(
            `Failed to process video ${i + 1}/${input.length}:`,
            error
          );
          throw error;
        }
      }

      step.output = results;
      step.status = "completed";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : "Unknown error";
      console.error("Runway processing failed:", {
        error: step.error,
        input,
      });
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
