import { fileURLToPath } from "url";
import * as path from "path";
import * as fs from "fs/promises";
import { logger } from "../../utils/logger";
import {
  reelTemplates,
  TemplateKey,
  ReelTemplate,
} from "../imageProcessing/templates/types";
import { VideoClip, videoProcessingService } from "./video-processing.service";
import { AssetManager } from "../assets/asset-manager";
import { AssetType } from "@prisma/client";
import { S3VideoService } from "./s3-video.service";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface VideoTemplate {
  name: string;
  description?: string;
  colorCorrection?: {
    ffmpegFilter: string;
  };
  transitions?: {
    type: "crossfade" | "fade" | "slide";
    duration: number;
  }[];
  reverseClips?: boolean;
  music?: {
    path: string;
    volume?: number;
    startTime?: number;
  };
  outputOptions?: string[];
}

export interface WatermarkConfig {
  path: string;
  position: {
    x: string;
    y: string;
  };
}

export class VideoTemplateService {
  private static instance: VideoTemplateService;

  private constructor(
    private readonly assetManager: AssetManager = AssetManager.getInstance(),
    private readonly s3VideoService: S3VideoService = S3VideoService.getInstance()
  ) {}

  public static getInstance(): VideoTemplateService {
    if (!VideoTemplateService.instance) {
      VideoTemplateService.instance = new VideoTemplateService();
    }
    return VideoTemplateService.instance;
  }

  private async validateMusicFile(musicPath: string): Promise<boolean> {
    try {
      // First try with ffprobe
      const duration = await videoProcessingService.getVideoDuration(musicPath);
      if (duration > 0) return true;

      // If ffprobe fails, try to read the file as a buffer to verify it exists
      const buffer = await fs.readFile(musicPath);
      if (buffer.length === 0) {
        logger.warn("Music file is empty", { path: musicPath });
        return false;
      }

      return true;
    } catch (error) {
      logger.warn("Music file validation failed", {
        path: musicPath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Resolves asset paths using AssetManager or falls back to local filesystem
   */
  public async resolveAssetPath(
    assetPath: string,
    assetType: "music" | "watermark",
    download = false
  ): Promise<string | null> {
    try {
      const assetName = path.basename(assetPath);

      // Try primary asset first
      const resolvedPath = await this.assetManager.getAssetPath(
        assetType === "music" ? AssetType.MUSIC : AssetType.WATERMARK,
        assetName
      );

      if (resolvedPath) {
        // For music files, add validation
        if (assetType === "music") {
          const localPath = path.join(
            process.cwd(),
            "temp",
            `music_${Date.now()}.mp3`
          );
          await this.s3VideoService.downloadVideo(resolvedPath, localPath);

          const isValid = await this.validateMusicFile(localPath);
          if (!isValid) {
            logger.warn("Primary music file invalid, trying fallback", {
              originalPath: assetPath,
              resolvedPath,
            });

            // Try fallback music
            const fallbackPath = await this.assetManager.getAssetPath(
              AssetType.MUSIC,
              path.basename(assetPath),
              true // Force fallback by setting forceDownload to true
            );
            if (fallbackPath) {
              await this.s3VideoService.downloadVideo(fallbackPath, localPath);
              const fallbackValid = await this.validateMusicFile(localPath);
              if (fallbackValid) {
                return fallbackPath;
              }
            }

            if (download) {
              throw new Error(`No valid music file available for ${assetPath}`);
            }
            return null;
          }
        }

        return resolvedPath;
      }

      // Fallback to local filesystem
      const localPath = path.join(__dirname, "../../../", assetPath);
      try {
        await fs.access(localPath, fs.constants.R_OK);
        logger.info("Found asset in local filesystem", {
          originalPath: assetPath,
          resolvedPath: localPath,
        });
        return localPath;
      } catch (fsError) {
        logger.error("Failed to resolve asset path", {
          assetPath,
          type: assetType,
          fsError: fsError instanceof Error ? fsError.message : "Unknown error",
        });
        if (download) {
          throw new Error(
            `Required ${assetType} asset not found: ${assetPath}`
          );
        }
        return null;
      }
    } catch (error) {
      logger.error("Asset resolution failed", {
        assetPath,
        type: assetType,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      if (download) {
        throw error;
      }
      return null;
    }
  }

  private parseS3Url(url: string): { bucket: string; key: string } {
    const urlObj = new URL(url);
    const bucket = urlObj.hostname.split(".")[0];
    const key = urlObj.pathname.slice(1); // Remove leading slash
    return { bucket, key };
  }

  /**
   * Validates template transitions configuration
   */
  private validateTransitions(template: ReelTemplate): void {
    if (template.transitions) {
      if (!Array.isArray(template.transitions)) {
        throw new Error("Template transitions must be an array");
      }

      template.transitions.forEach((transition, index) => {
        if (!transition.type || !transition.duration) {
          throw new Error(`Invalid transition at index ${index}`);
        }
        if (!["crossfade", "fade", "slide"].includes(transition.type)) {
          throw new Error(`Invalid transition type at index ${index}`);
        }
        if (transition.duration <= 0) {
          throw new Error(`Invalid transition duration at index ${index}`);
        }
      });
    }
  }

  /**
   * Validates template color correction configuration
   */
  private validateColorCorrection(template: ReelTemplate): void {
    if (template.colorCorrection) {
      if (!template.colorCorrection.ffmpegFilter) {
        throw new Error("Color correction must include ffmpeg filter string");
      }
    }
  }

  public async createTemplate(
    templateKey: TemplateKey,
    inputVideos: string[],
    mapVideoPath?: string,
    options?: {
      watermark?: boolean;
    }
  ): Promise<VideoClip[]> {
    logger.info("Creating template", {
      templateKey,
      videoCount: inputVideos.length,
      hasMapVideo: !!mapVideoPath,
    });

    // Validate inputs
    if (!inputVideos.length) {
      throw new Error("No input videos provided");
    }

    // Validate template exists
    const template = reelTemplates[templateKey];
    if (!template) {
      logger.error("Template not found", { templateKey });
      throw new Error(`Template ${templateKey} not found`);
    }

    // Validate sequence and durations
    if (!template.sequence.length) {
      throw new Error("Template sequence cannot be empty");
    }
    if (
      !template.durations ||
      (Array.isArray(template.durations) && !template.durations.length)
    ) {
      throw new Error("Template must have valid durations");
    }

    // Handle watermark if needed
    let watermarkConfig: WatermarkConfig | undefined;
    if (options?.watermark) {
      try {
        const watermarkPath = await this.resolveAssetPath(
          // "reelty_watermark.png",
          "watermark_transparent_v1.png",
          "watermark",
          true // Watermark is always required if specified
        );
        if (watermarkPath) {
          watermarkConfig = {
            path: watermarkPath,
            position: { x: "(main_w-overlay_w)/2", y: "main_h-overlay_h-300" },
          };
          logger.info("Watermark configured successfully", {
            path: watermarkPath,
            template: templateKey,
          });
        } else {
          throw new Error("Watermark file not found");
        }
      } catch (error) {
        logger.error("Failed to configure watermark", {
          error: error instanceof Error ? error.message : "Unknown error",
          template: templateKey,
        });
        throw error;
      }
    }

    const templateConfig = reelTemplates[templateKey];
    const durations = Array.isArray(templateConfig.durations)
      ? templateConfig.durations
      : Object.values(templateConfig.durations);

    // Limit to available segments and ensure durations match
    const combinedVideos: string[] = [];
    const adjustedDurations: number[] = [];
    let segmentCount = 0;

    for (const item of templateConfig.sequence) {
      if (segmentCount >= inputVideos.length) break; // Stop when we run out of videos
      if (item === "map") {
        if (mapVideoPath) {
          combinedVideos.push(mapVideoPath);
          adjustedDurations.push(
            typeof templateConfig.durations === "object"
              ? (templateConfig.durations as Record<string, number>).map
              : durations[segmentCount]
          );
        }
      } else {
        const videoIndex = typeof item === "string" ? parseInt(item) : item;
        if (videoIndex < inputVideos.length) {
          combinedVideos.push(inputVideos[videoIndex]);
          adjustedDurations.push(durations[segmentCount]);
          segmentCount++;
        }
      }
    }

    // Log configuration for debugging
    logger.info(`Template ${templateKey} clip configuration:`, {
      clipCount: combinedVideos.length,
      totalDuration: adjustedDurations.reduce((sum, d) => sum + (d || 0), 0),
      durations: adjustedDurations,
      sequence: templateConfig.sequence.slice(0, segmentCount),
    });

    // Create clips with proper configuration
    const clips = combinedVideos.map((path, index) => {
      const duration = adjustedDurations[index];
      if (duration === undefined) {
        throw new Error(`No duration defined for clip ${index}: ${path}`);
      }
      return {
        path,
        duration,
        transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
        colorCorrection: templateConfig.colorCorrection,
      };
    });

    if (clips.length === 0) {
      throw new Error("No valid clips generated from template configuration");
    }

    // Resolve music path if present
    if (template.music?.path) {
      const resolvedMusicPath = await this.resolveAssetPath(
        template.music.path,
        "music",
        true // Always require music if specified
      );

      if (!resolvedMusicPath) {
        throw new Error(`Music file not found: ${template.music.path}`);
      }

      template.music.path = resolvedMusicPath;
      template.music.isValid = true;
      logger.info("Music file resolved and verified", {
        originalPath: template.music.path,
        resolvedPath: resolvedMusicPath,
        volume: template.music.volume,
        startTime: template.music.startTime,
      });
    }

    return clips;
  }

  async extractThumbnail(videoPath: string): Promise<string> {
    const outputPath = path.join(
      process.env.TEMP_DIR || "./temp",
      `thumbnail-${Date.now()}.webp`
    );
    await videoProcessingService.extractFrame(videoPath, outputPath, 1);
    return outputPath;
  }
}

export const videoTemplateService = VideoTemplateService.getInstance();
