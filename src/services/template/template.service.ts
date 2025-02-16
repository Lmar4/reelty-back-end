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
import { PrismaClient, Prisma } from "@prisma/client";
import * as fs from "fs";

const prisma = new PrismaClient();

// Define the extended SubscriptionTier type that includes our new fields
type SubscriptionTierWithPremium = Prisma.SubscriptionTierGetPayload<{
  select: {
    id: true;
    name: true;
    description: true;
    stripePriceId: true;
    stripeProductId: true;
    features: true;
    monthlyPrice: true;
    planType: true;
    creditsPerInterval: true;
    hasWatermark: true;
    maxPhotosPerListing: true;
    maxReelDownloads: true;
    maxActiveListings: true;
    premiumTemplatesEnabled: true;
    createdAt: true;
    updatedAt: true;
  };
}>;

export interface ProcessingResult {
  success: boolean;
  template?: TemplateKey;
  outputPath?: string;
  error?: string;
}

export class TemplateService {
  private static instance: TemplateService;
  private prisma: PrismaClient;

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): TemplateService {
    if (!TemplateService.instance) {
      TemplateService.instance = new TemplateService();
    }
    return TemplateService.instance;
  }

  public async checkTemplateAccess(
    userId: string,
    template: TemplateKey
  ): Promise<boolean> {
    try {
      // Get user's subscription tier
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          currentTierId: true,
          currentTier: {
            select: {
              premiumTemplatesEnabled: true,
            },
          },
        },
      });

      if (!user?.currentTierId || !user.currentTier) {
        logger.warn(`No subscription tier found for user ${userId}`);
        return false;
      }

      // Check if the template is premium and if the user has access
      const isPremiumTemplate = this.isPremiumTemplate(template);
      if (isPremiumTemplate && !user.currentTier.premiumTemplatesEnabled) {
        logger.info(
          `User ${userId} does not have access to premium template ${template}`
        );
        return false;
      }

      return true;
    } catch (error) {
      logger.error("Error checking template access", {
        userId,
        template,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  private isPremiumTemplate(template: TemplateKey): boolean {
    // Define which templates are premium
    const premiumTemplates: TemplateKey[] = ["googlezoomintro", "crescendo"];
    return premiumTemplates.includes(template);
  }

  public async processTemplate(
    template: TemplateKey,
    videos: string[],
    options: {
      jobId: string;
      userId: string;
      coordinates?: { lat: number; lng: number };
    }
  ): Promise<ProcessingResult> {
    logger.info(`[${options.jobId}] Processing template ${template}`, {
      videoCount: videos.length,
      hasCoordinates: !!options.coordinates,
      userId: options.userId,
    });

    // Check template access
    const hasAccess = await this.checkTemplateAccess(options.userId, template);
    if (!hasAccess) {
      logger.error(`[${options.jobId}] Template access denied`, {
        template,
        userId: options.userId,
      });
      return {
        success: false,
        template,
        error: `Access to template ${template} denied`,
      };
    }

    // Validate template exists
    const templateConfig = reelTemplates[template];
    if (!templateConfig) {
      logger.error(`[${options.jobId}] Template not found`, { template });
      return {
        success: false,
        template,
        error: `Template ${template} not found`,
      };
    }

    try {
      // Handle map video requirement for any template with "map" in sequence
      let coordinates: { lat: number; lng: number } | undefined;

      if (templateConfig.sequence.includes("map")) {
        // Try to get coordinates from options first
        coordinates = options.coordinates;

        // If no coordinates in options, try to get from job
        if (!coordinates) {
          const job = await this.prisma.videoJob.findUnique({
            where: { id: options.jobId },
            include: { listing: true },
          });

          if (job?.listing?.coordinates) {
            try {
              coordinates =
                typeof job.listing.coordinates === "string"
                  ? JSON.parse(job.listing.coordinates)
                  : job.listing.coordinates;

              logger.info(`[${options.jobId}] Found coordinates for map:`, {
                coordinates,
                template,
              });
            } catch (err) {
              logger.warn(`[${options.jobId}] Failed to parse coordinates`, {
                error: err,
                template,
              });
            }
          }
        }
      }

      // If still no coordinates, return error
      if (!coordinates) {
        logger.error(
          `[${options.jobId}] Coordinates required for template with map`,
          {
            template,
          }
        );
        return {
          success: false,
          template,
          error: "Coordinates required for template with map sequence",
        };
      }

      // Generate map video
      logger.info(`[${options.jobId}] Generating map video for coordinates:`, {
        coordinates: coordinates,
        template,
      });

      const mapVideo = await this.ensureMapVideo(coordinates, options.jobId);

      if (!mapVideo) {
        logger.error(`[${options.jobId}] Failed to generate map video`, {
          template,
        });
        return {
          success: false,
          template,
          error: "Failed to generate map video",
        };
      }

      logger.info(`[${options.jobId}] Map video generated successfully:`, {
        mapVideoPath: mapVideo,
        template,
      });

      // Validate video count
      const requiredVideos = templateConfig.sequence.filter(
        (s) => typeof s === "number"
      ).length;
      if (videos.length < requiredVideos) {
        logger.error(`[${options.jobId}] Not enough videos`, {
          required: requiredVideos,
          provided: videos.length,
          template,
        });
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
        logger.info(`[${options.jobId}] Cache hit for template`, {
          template,
          cached,
        });
        return {
          success: true,
          template,
          outputPath: cached,
        };
      }

      // Process template using video template service
      logger.info(`[${options.jobId}] Creating template clips`, {
        template,
        videoCount: videos.length,
        hasMapVideo: !!mapVideo,
      });

      const clips = await videoTemplateService.createTemplate(
        template,
        videos,
        mapVideo
      );

      logger.info(`[${options.jobId}] Template clips created`, {
        template,
        clipCount: clips.length,
      });

      const outputPath = await this.stitchClips(clips, options.jobId);

      // Cache the result for next time
      await assetCacheManager.updateTemplateResult(cacheKey, outputPath);

      logger.info(`[${options.jobId}] Template processing complete`, {
        template,
        outputPath,
      });

      return {
        success: true,
        template,
        outputPath,
      };
    } catch (error) {
      logger.error(`[${options.jobId}] Template processing failed`, {
        template,
        error: error instanceof Error ? error.message : "Unknown error",
      });
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

  private async ensureMapVideo(
    coordinates: { lat: number; lng: number },
    jobId: string
  ): Promise<string | undefined> {
    try {
      return await mapCaptureService.generateMapVideo(coordinates, jobId);
    } catch (error) {
      logger.error(`[${jobId}] Failed to capture map video`, {
        coordinates,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return undefined;
    }
  }

  public async processWithFallbacks(
    jobId: string,
    userId: string,
    videos: string[],
    coordinates?: { lat: number; lng: number }
  ): Promise<ProcessingResult> {
    // Get user's subscription tier to determine available templates
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        currentTierId: true,
        currentTier: {
          select: {
            premiumTemplatesEnabled: true,
          },
        },
      },
    });

    // Filter templates based on user's access
    let templatePriority: TemplateKey[] = ["wave", "storyteller"];

    if (user?.currentTier?.premiumTemplatesEnabled) {
      templatePriority = ["googlezoomintro", "crescendo", ...templatePriority];
    }

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
        userId,
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

  private async stitchClipsWithMusic(
    clips: VideoClip[],
    jobId: string,
    music?: { path: string; volume?: number; startTime?: number }
  ): Promise<string> {
    return retryService.withRetry(
      async () => {
        const outputPath = path.join(
          process.env.TEMP_OUTPUT_DIR || "./temp",
          `template-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`
        );

        // If music is configured, resolve the absolute path and check if file exists
        let musicConfig:
          | { path: string; volume?: number; startTime?: number }
          | undefined;
        if (music?.path) {
          // First try in public directory
          const publicMusicPath = path.join(
            process.cwd(),
            "public",
            music.path
          );
          logger.info("Resolving music path", {
            original: music.path,
            publicPath: publicMusicPath,
          });
          try {
            await fs.promises.access(publicMusicPath);
            musicConfig = {
              path: publicMusicPath,
              volume: music.volume,
              startTime: music.startTime,
            };
            logger.info(`[${jobId}] Using music track from public directory`, {
              originalPath: music.path,
              resolvedPath: publicMusicPath,
              volume: music.volume,
              startTime: music.startTime,
            });
          } catch (error) {
            logger.warn(
              `[${jobId}] Music file not found in public directory, trying alternative paths`,
              {
                error: error instanceof Error ? error.message : "Unknown error",
              }
            );
            // Try alternative paths
            const altPaths = [
              path.join(process.cwd(), music.path),
              path.join(__dirname, "../../../public", music.path),
              path.join(__dirname, "../../../", music.path),
            ];

            for (const altPath of altPaths) {
              try {
                await fs.promises.access(altPath);
                musicConfig = {
                  path: altPath,
                  volume: music.volume,
                  startTime: music.startTime,
                };
                logger.info(
                  `[${jobId}] Using music track from alternative path`,
                  {
                    originalPath: music.path,
                    resolvedPath: altPath,
                    volume: music.volume,
                    startTime: music.startTime,
                  }
                );
                break;
              } catch (err) {
                // Continue to next path
              }
            }

            if (!musicConfig) {
              logger.error(
                `[${jobId}] Music file not found in any location, proceeding without music`,
                {
                  originalPath: music.path,
                  triedPaths: [publicMusicPath, ...altPaths],
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                }
              );
            }
          }
        }

        await videoProcessingService.stitchVideos(
          clips.map((clip) => clip.path),
          clips.map((clip) => clip.duration),
          outputPath,
          musicConfig
            ? {
                name: "Music Template",
                description: "Template for music-only processing",
                sequence: clips.map((_, i) => i),
                durations: clips.map((clip) => clip.duration),
                music: musicConfig,
              }
            : undefined
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

  public async createTemplate(
    templateKey: TemplateKey,
    videoFiles: string[],
    mapVideo?: string
  ): Promise<Array<{ path: string; duration: number }>> {
    logger.info("Creating template", {
      hasMapVideo: !!mapVideo,
      templateKey,
      videoCount: videoFiles.length,
    });

    const template = reelTemplates[templateKey];
    if (!template) {
      throw new Error(`Template ${templateKey} not found`);
    }

    // Validate video count
    if (videoFiles.length === 0) {
      throw new Error("No video files provided");
    }

    // For templates with map video
    if (templateKey === "googlezoomintro") {
      if (!mapVideo) {
        throw new Error("Map video is required for googlezoomintro template");
      }

      const orderedVideos: Array<{ path: string; duration: number }> = [];
      const durations = template.durations as Record<string | number, number>;

      // Process each item in the sequence
      for (const key of template.sequence) {
        if (key === "map") {
          orderedVideos.push({ path: mapVideo, duration: durations["map"] });
        } else {
          const index = typeof key === "string" ? parseInt(key) : key;
          if (index < 0 || index >= videoFiles.length) {
            throw new Error(
              `Invalid video index ${index} for template ${templateKey}`
            );
          }
          orderedVideos.push({
            path: videoFiles[index],
            duration: durations[key.toString()],
          });
        }
      }

      logger.info("Template clips created", {
        clipCount: orderedVideos.length,
        clipPaths: orderedVideos.map((c) => c.path),
        durations: orderedVideos.map((c) => c.duration),
        hasMapVideo: true,
      });

      return orderedVideos;
    }

    // Regular template processing
    const orderedVideos = template.sequence.map((index) => {
      const videoIndex = typeof index === "number" ? index : parseInt(index);
      if (videoIndex < 0 || videoIndex >= videoFiles.length) {
        throw new Error(
          `Invalid video index ${videoIndex} for template ${templateKey}`
        );
      }
      const durations = template.durations as number[];
      return {
        path: videoFiles[videoIndex],
        duration: durations[videoIndex],
      };
    });

    logger.info("Template clips created", {
      clipCount: orderedVideos.length,
      clipPaths: orderedVideos.map((c) => c.path),
      durations: orderedVideos.map((c) => c.duration),
      hasMapVideo: false,
    });

    return orderedVideos;
  }
}

// Export singleton instance
export const templateService = TemplateService.getInstance();
