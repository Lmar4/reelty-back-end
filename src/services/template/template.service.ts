import * as path from "path";
import { logger } from "../../utils/logger";
import { assetCacheManager } from "../cache/cache-manager";
import { reelTemplates, TemplateKey } from "../imageProcessing/templates/types";
import { mapCaptureService } from "../map-capture/map-capture.service";
import { retryService } from "../retry/retry.service";
import {
  VideoClip,
  videoProcessingService,
} from "../video/video-processing.service";
import { videoTemplateService } from "../video/video-template.service";

export interface ProcessingResult {
  success: boolean;
  template?: TemplateKey;
  outputPath?: string;
  error?: string;
}

export class TemplateService {
  private static instance: TemplateService;

  private constructor() {}

  public static getInstance(): TemplateService {
    if (!TemplateService.instance) {
      TemplateService.instance = new TemplateService();
    }
    return TemplateService.instance;
  }

  private async ensureMapVideo(
    coordinates: { lat: number; lng: number },
    jobId: string
  ): Promise<string | undefined> {
    try {
      return await retryService.withRetry(
        async () => {
          return await mapCaptureService.generateMapVideo(coordinates, jobId);
        },
        {
          jobId,
          maxRetries: 3,
          delays: [2000, 5000, 10000],
        }
      );
    } catch (error) {
      logger.error(`[${jobId}] Failed to generate map video`, {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
      });
      return undefined;
    }
  }

  public async processTemplate(
    template: TemplateKey,
    videos: string[],
    options: {
      jobId: string;
      coordinates?: { lat: number; lng: number };
    }
  ): Promise<ProcessingResult> {
    const config = reelTemplates[template];

    try {
      // Handle map video requirement for googlezoomintro
      let mapVideo: string | undefined;
      if (template === "googlezoomintro") {
        if (!options.coordinates) {
          return {
            success: false,
            template,
            error: "Coordinates required for googlezoomintro template",
          };
        }

        mapVideo = await this.ensureMapVideo(
          options.coordinates,
          options.jobId
        );
        if (!mapVideo) {
          return {
            success: false,
            template,
            error: "Failed to generate map video",
          };
        }
      }

      // Validate video count
      const requiredVideos = config.sequence.filter(
        (s) => typeof s === "number"
      ).length;
      if (videos.length < requiredVideos) {
        return {
          success: false,
          template,
          error: `Not enough videos. Required: ${requiredVideos}, Got: ${videos.length}`,
        };
      }

      // Check cache first
      const cacheKey = `${template}_${videos.join("_")}${
        mapVideo ? "_map" : ""
      }`;
      const cached = await assetCacheManager.getTemplateResult(
        cacheKey,
        mapVideo ? [...videos, mapVideo] : videos
      );
      if (cached && !cached.startsWith("processed_template_")) {
        // Skip placeholder results
        return {
          success: true,
          template,
          outputPath: cached,
        };
      }

      // Process template using video template service
      const clips = await videoTemplateService.createTemplate(
        template,
        videos,
        mapVideo
      );

      const outputPath = await this.stitchClips(clips, options.jobId);

      // Cache the result for next time
      await assetCacheManager.updateTemplateResult(cacheKey, outputPath);

      return {
        success: true,
        template,
        outputPath,
      };
    } catch (error) {
      return {
        success: false,
        template,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async stitchClips(
    clips: VideoClip[],
    jobId: string
  ): Promise<string> {
    return retryService.withRetry(
      async () => {
        const outputPath = path.join(
          process.env.TEMP_OUTPUT_DIR || "./temp",
          `template-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`
        );

        await videoProcessingService.stitchVideos(
          clips.map((clip) => clip.path),
          clips.map((clip) => clip.duration),
          outputPath
        );

        return outputPath;
      },
      {
        jobId,
        maxRetries: 3,
        delays: [2000, 5000, 10000],
      }
    );
  }

  public async processWithFallbacks(
    jobId: string,
    videos: string[],
    coordinates?: { lat: number; lng: number }
  ): Promise<ProcessingResult> {
    // Try templates in priority order
    const templatePriority: TemplateKey[] = [
      "googlezoomintro",
      "wave",
      "crescendo",
      "storyteller",
    ];

    for (const template of templatePriority) {
      // Skip googlezoomintro if no coordinates
      if (template === "googlezoomintro" && !coordinates) {
        logger.info(
          `[${jobId}] Skipping googlezoomintro template - no coordinates provided`
        );
        continue;
      }

      const result = await this.processTemplate(template, videos, {
        jobId,
        coordinates,
      });

      if (result.success) {
        return result;
      }

      logger.warn(`[${jobId}] Template ${template} failed`, {
        error: result.error,
      });
    }

    return {
      success: false,
      error: "All templates failed or were skipped",
    };
  }
}

export const templateService = TemplateService.getInstance();
