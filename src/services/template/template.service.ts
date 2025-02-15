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
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";

const prisma = new PrismaClient();

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

  public async processTemplate(
    template: TemplateKey,
    videos: string[],
    options: {
      jobId: string;
      coordinates?: { lat: number; lng: number };
    }
  ): Promise<ProcessingResult> {
    logger.info(`[${options.jobId}] Processing template ${template}`, {
      videoCount: videos.length,
      hasCoordinates: !!options.coordinates,
    });

    // Validate template exists
    const config = reelTemplates[template];
    if (!config) {
      logger.error(`[${options.jobId}] Template not found`, { template });
      return {
        success: false,
        template,
        error: `Template ${template} not found`,
      };
    }

    try {
      // Handle map video requirement for googlezoomintro
      let mapVideo: string | undefined;
      if (template === "googlezoomintro") {
        if (!options.coordinates) {
          logger.error(
            `[${options.jobId}] Coordinates required for googlezoomintro`
          );
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
          logger.error(`[${options.jobId}] Failed to generate map video`);
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
        logger.error(`[${options.jobId}] Not enough videos`, {
          required: requiredVideos,
          provided: videos.length,
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

  public async testTemplateWithExistingVideos(
    listingId: string,
    template: TemplateKey
  ): Promise<ProcessingResult> {
    const jobId = `test_${Date.now()}`;
    logger.info(
      `[${jobId}] Testing template ${template} with existing videos for listing ${listingId}`
    );

    try {
      // Get photos with runway videos for this listing
      const photos = await prisma.photo.findMany({
        where: {
          listingId,
          runwayVideoPath: { not: null },
        },
        orderBy: { order: "asc" },
      });

      if (photos.length === 0) {
        logger.error(
          `[${jobId}] No runway videos found for listing ${listingId}`
        );
        return {
          success: false,
          template,
          error: "No runway videos found for this listing",
        };
      }

      // Extract video paths
      const videos = photos
        .map((photo) => photo.runwayVideoPath)
        .filter((path): path is string => path !== null);

      logger.info(`[${jobId}] Found ${videos.length} runway videos`, {
        listingId,
        videoCount: videos.length,
      });

      // Get listing coordinates for map video if needed
      const listing = await prisma.listing.findUnique({
        where: { id: listingId },
      });

      const coordinates = listing?.coordinates
        ? JSON.parse(listing.coordinates as string)
        : undefined;

      // Process the template
      return await this.processTemplate(template, videos, {
        jobId,
        coordinates,
      });
    } catch (error) {
      logger.error(`[${jobId}] Test failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return {
        success: false,
        template,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  public async testTemplateWithProcessedAssets(
    template: TemplateKey,
    count: number = 10,
    coordinates?: { lat: number; lng: number },
    existingMapVideoPath?: string
  ): Promise<ProcessingResult> {
    const jobId = `test_${Date.now()}`;
    logger.info(
      `[${jobId}] Testing template ${template} with processed assets`,
      {
        template,
        requestedCount: count,
        hasCoordinates: !!coordinates,
        coordinates,
        hasExistingMapVideo: !!existingMapVideoPath,
      }
    );

    try {
      // Get runway videos from ProcessedAsset table
      const assets = await prisma.processedAsset.findMany({
        where: {
          type: "runway",
          path: { contains: "segment" },
        },
        take: count,
        orderBy: {
          createdAt: "desc",
        },
      });

      logger.info(`[${jobId}] Found ProcessedAsset records`, {
        count: assets.length,
        firstAsset: assets[0],
        lastAsset: assets[assets.length - 1],
      });

      if (assets.length === 0) {
        logger.error(
          `[${jobId}] No runway videos found in ProcessedAsset table`
        );
        return {
          success: false,
          template,
          error: "No runway videos found",
        };
      }

      // Extract video paths and verify they exist
      const videos = assets.map((asset) => asset.path);
      for (const video of videos) {
        try {
          await fs.promises.access(video);
        } catch (error) {
          logger.error(`[${jobId}] Video file not found`, {
            path: video,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return {
            success: false,
            template,
            error: `Video file not found: ${video}`,
          };
        }
      }

      logger.info(`[${jobId}] Found ${videos.length} runway videos`, {
        videoCount: videos.length,
        paths: videos,
      });

      // For googlezoomintro, ensure we have map video
      let mapVideo: string | undefined;
      if (template === "googlezoomintro") {
        if (existingMapVideoPath) {
          try {
            await fs.promises.access(existingMapVideoPath);
            mapVideo = existingMapVideoPath;
            logger.info(`[${jobId}] Using existing map video`, {
              path: existingMapVideoPath,
            });
          } catch (error) {
            logger.error(`[${jobId}] Existing map video not found`, {
              path: existingMapVideoPath,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return {
              success: false,
              template,
              error: `Existing map video not found: ${existingMapVideoPath}`,
            };
          }
        } else if (coordinates) {
          logger.info(
            `[${jobId}] Generating map video for coordinates`,
            coordinates
          );
          mapVideo = await this.ensureMapVideo(coordinates, jobId);

          if (!mapVideo) {
            return {
              success: false,
              template,
              error: "Failed to generate map video",
            };
          }

          logger.info(`[${jobId}] Map video generated`, {
            path: mapVideo,
          });
        }
      }

      // Get template configuration for music
      const templateConfig = reelTemplates[template];
      if (!templateConfig) {
        return {
          success: false,
          template,
          error: `Template ${template} not found`,
        };
      }

      logger.info(`[${jobId}] Using template configuration`, {
        template,
        config: templateConfig,
      });

      // Process the template with music configuration
      const clips = await videoTemplateService.createTemplate(
        template,
        videos,
        mapVideo
      );

      logger.info(`[${jobId}] Template clips created`, {
        template,
        clipCount: clips.length,
        hasMapVideo: !!mapVideo,
        hasMusicConfig: !!templateConfig.music,
        clips: clips.map((c) => ({ path: c.path, duration: c.duration })),
      });

      const outputPath = await this.stitchClipsWithMusic(
        clips,
        jobId,
        templateConfig.music
      );

      logger.info(`[${jobId}] Template processing complete`, {
        template,
        outputPath,
        hasMapVideo: !!mapVideo,
        hasMusicConfig: !!templateConfig.music,
      });

      return {
        success: true,
        template,
        outputPath,
      };
    } catch (error) {
      logger.error(`[${jobId}] Test failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        template,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
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
          musicConfig ? { music: musicConfig } : undefined
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
