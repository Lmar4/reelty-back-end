import { VideoGenerationStatus } from "@prisma/client";
import { v4 as uuid } from "uuid";
import { assetCacheManager } from "../cache/cache-manager";
import { rateLimiter } from "../utils/rate-limiter";
import { Asset, JobStatus } from "../../types/video-processing";
import { prisma } from "../../lib/prisma";

export class VideoProcessor {
  private static instance: VideoProcessor;

  private constructor() {}

  static getInstance(): VideoProcessor {
    if (!VideoProcessor.instance) {
      VideoProcessor.instance = new VideoProcessor();
    }
    return VideoProcessor.instance;
  }

  async processJob(
    userId: string,
    listingId: string,
    images: string[],
    templateId: string
  ): Promise<JobStatus> {
    const jobId = uuid();

    // Create job record in database
    const videoJob = await prisma.videoJob.create({
      data: {
        id: jobId,
        userId,
        listingId,
        status: VideoGenerationStatus.PENDING,
        progress: 0,
        template: templateId,
      },
    });

    // Process in background
    this.processInBackground(jobId, userId, listingId, images, templateId);

    return {
      jobId,
      status: VideoGenerationStatus.PENDING,
      progress: 0,
      assets: [],
    };
  }

  /**
   * Updates job progress with proper weighting for new features
   */
  private async updateJobProgress(
    jobId: string,
    stage: string,
    progress: number
  ): Promise<void> {
    // Stages and their weights
    const stageWeights = {
      imageProcessing: 0.3,
      videoSegments: 0.3,
      transitions: 0.2,
      colorCorrection: 0.1,
      finalComposition: 0.1,
    };

    const stageProgress = progress / 100;
    let totalProgress = 0;

    switch (stage) {
      case "imageProcessing":
        totalProgress = stageProgress * stageWeights.imageProcessing;
        break;
      case "videoSegments":
        totalProgress =
          stageWeights.imageProcessing +
          stageProgress * stageWeights.videoSegments;
        break;
      case "transitions":
        totalProgress =
          stageWeights.imageProcessing +
          stageWeights.videoSegments +
          stageProgress * stageWeights.transitions;
        break;
      case "colorCorrection":
        totalProgress =
          stageWeights.imageProcessing +
          stageWeights.videoSegments +
          stageWeights.transitions +
          stageProgress * stageWeights.colorCorrection;
        break;
      case "finalComposition":
        totalProgress =
          stageWeights.imageProcessing +
          stageWeights.videoSegments +
          stageWeights.transitions +
          stageWeights.colorCorrection +
          stageProgress * stageWeights.finalComposition;
        break;
    }

    await this.updateJobStatus(
      jobId,
      VideoGenerationStatus.PROCESSING,
      Math.round(totalProgress * 100)
    );
  }

  private async processInBackground(
    jobId: string,
    userId: string,
    listingId: string,
    images: string[],
    templateId: string
  ): Promise<void> {
    try {
      // Update status to processing
      await this.updateJobStatus(jobId, VideoGenerationStatus.PROCESSING, 0);

      // 1. Process all images in parallel with rate limiting
      const processedImages = await Promise.all(
        images.map(async (img, index) => {
          try {
            const processedUrl = await rateLimiter.schedule(() =>
              assetCacheManager.getProcessedImage(img)
            );

            return {
              id: `${index}`,
              url: processedUrl,
              type: "image" as const,
              processed: true,
            };
          } catch (err) {
            const error = err as Error;
            console.error(`Failed to process image ${img}:`, error);
            return {
              id: `${index}`,
              url: img,
              type: "image" as const,
              processed: false,
              error: error.message,
            };
          }
        })
      );

      await this.updateJobStatus(jobId, VideoGenerationStatus.PROCESSING, 30);

      // 2. Generate video segments with rate limiting
      const videoSegments = await Promise.all(
        processedImages.map(async (img, index) => {
          if (!img.processed) return img;

          try {
            const videoUrl = await rateLimiter.schedule(() =>
              assetCacheManager.getVideoSegment(img.url, index)
            );

            return {
              id: `video_${index}`,
              url: videoUrl,
              type: "video" as const,
              processed: true,
            };
          } catch (err) {
            const error = err as Error;
            console.error(`Failed to generate video for ${img.url}:`, error);
            return {
              id: `video_${index}`,
              url: img.url,
              type: "video" as const,
              processed: false,
              error: error.message,
            };
          }
        })
      );

      await this.updateJobStatus(jobId, VideoGenerationStatus.PROCESSING, 60);

      // 3. Apply template
      const finalVideo = await rateLimiter.schedule(() =>
        assetCacheManager.getTemplateResult(
          templateId,
          videoSegments.map((v) => v.url)
        )
      );

      // Update final status
      const assets: Asset[] = [
        ...processedImages,
        ...videoSegments,
        {
          id: "final",
          url: finalVideo,
          type: "video",
          processed: true,
        },
      ];

      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.COMPLETED,
        100,
        assets
      );
    } catch (err) {
      const error = err as Error;
      console.error("Job processing failed:", error);
      await this.updateJobStatus(
        jobId,
        VideoGenerationStatus.FAILED,
        0,
        [],
        error.message
      );
    }
  }

  private async updateJobStatus(
    jobId: string,
    status: VideoGenerationStatus,
    progress: number,
    assets: Asset[] = [],
    error?: string
  ): Promise<void> {
    await prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        progress,
        outputFile: assets.find((a) => a.id === "final")?.url,
        error,
      },
    });
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const job = await prisma.videoJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      assets: job.outputFile
        ? [
            {
              id: "final",
              url: job.outputFile,
              type: "video",
              processed: true,
            },
          ]
        : [],
      error: job.error || undefined,
    };
  }
}

export const videoProcessor = VideoProcessor.getInstance();
