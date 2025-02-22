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

  /**
   * Resolves asset paths using AssetManager or falls back to local filesystem
   */
  private async resolveAssetPath(
    assetPath: string,
    type: "music" | "watermark",
    isRequired: boolean = false
  ): Promise<string | null> {
    try {
      // Map type to AssetType enum
      const assetType =
        type === "music" ? AssetType.MUSIC : AssetType.WATERMARK;
      const assetName = path.basename(assetPath);

      // Use AssetManager to fetch from S3 or local cache
      const resolvedPath = await this.assetManager.getAssetPath(
        assetType,
        assetName
      );

      if (resolvedPath) {
        // If it's an S3 URL, verify it exists
        if (resolvedPath.startsWith("https://")) {
          const { bucket, key } = this.parseS3Url(resolvedPath);
          const exists = await this.s3VideoService.checkFileExists(bucket, key);
          if (!exists) {
            logger.warn("Asset not found in S3", {
              originalPath: assetPath,
              resolvedPath,
              type,
            });
            if (isRequired) {
              throw new Error(
                `Required ${type} asset not found in S3: ${assetPath}`
              );
            }
            return null;
          }
        } else {
          // If it's a local file, verify it exists
          try {
            await fs.access(resolvedPath, fs.constants.R_OK);
          } catch (error) {
            logger.warn("Local asset not accessible", {
              originalPath: assetPath,
              resolvedPath,
              type,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            if (isRequired) {
              throw new Error(
                `Required ${type} asset not accessible: ${assetPath}`
              );
            }
            return null;
          }
        }

        logger.info("Asset resolved and verified", {
          originalPath: assetPath,
          resolvedPath,
          type,
        });
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
          type,
          fsError: fsError instanceof Error ? fsError.message : "Unknown error",
        });
        if (isRequired) {
          throw new Error(`Required ${type} asset not found: ${assetPath}`);
        }
        return null;
      }
    } catch (error) {
      logger.error("Asset resolution failed", {
        assetPath,
        type,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      if (isRequired) {
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

    // Check if music is required for this template
    const isMusicRequired =
      templateKey === "storyteller" || templateKey === "crescendo";

    // Resolve music path if present
    if (template.music?.path) {
      const resolvedMusicPath = await this.resolveAssetPath(
        template.music.path,
        "music",
        isMusicRequired
      );
      if (resolvedMusicPath) {
        template.music.path = resolvedMusicPath;
        template.music.isValid = true;
        logger.info("Music file resolved and verified", {
          originalPath: template.music.path,
          resolvedPath: resolvedMusicPath,
          volume: template.music.volume,
          startTime: template.music.startTime,
        });
      } else {
        template.music.isValid = false;
        if (isMusicRequired) {
          throw new Error(
            `Required music file not found for template ${templateKey}`
          );
        }
        logger.warn("No valid music file found, proceeding without music", {
          originalPath: template.music.path,
          template: templateKey,
        });
      }
    } else if (isMusicRequired) {
      throw new Error(
        `Music path not specified for template ${templateKey} which requires music`
      );
    }

    // Handle watermark if needed
    let watermarkConfig: WatermarkConfig | undefined;
    if (options?.watermark) {
      try {
        const watermarkPath = await this.resolveAssetPath(
          "reelty_watermark.png",
          "watermark",
          true // Watermark is always required if specified
        );
        if (watermarkPath) {
          watermarkConfig = {
            path: watermarkPath,
            position: { x: "(main_w-overlay_w)/2", y: "main_h-overlay_h-20" },
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

    // Rest of the method remains unchanged...
    const videoSlots = template.sequence.filter((s) => s !== "map").length;
    const availableVideos = inputVideos.length;
    const hasMapRequirement = template.sequence.includes("map");

    if (hasMapRequirement && !mapVideoPath) {
      logger.error("Map video required but not provided", { templateKey });
      throw new Error("Map video required but not provided");
    }

    logger.info("Template analysis", {
      totalSlots: template.sequence.length,
      videoSlots,
      availableVideos,
      hasMapVideo: !!mapVideoPath,
      hasMapRequirement,
      hasTransitions: !!template.transitions?.length,
      hasMusic: !!template.music?.isValid,
    });

    const adaptedSequence = template.sequence.filter((item) => {
      if (item === "map") return true;
      const index = typeof item === "number" ? item : parseInt(item);
      if (isNaN(index)) {
        logger.warn("Invalid sequence item, skipping", { item });
        return false;
      }
      const hasVideo = index < availableVideos;
      if (!hasVideo) {
        logger.info("Skipping out-of-range index", {
          index,
          availableVideos,
          template: templateKey,
        });
      }
      return hasVideo;
    });

    const usedDurations = adaptedSequence.map((_, i) => {
      if (Array.isArray(template.durations)) {
        return template.durations[i];
      }
      return template.durations[adaptedSequence[i]];
    });

    const clips: VideoClip[] = [];
    for (let i = 0; i < adaptedSequence.length; i++) {
      const sequenceItem = adaptedSequence[i];

      if (sequenceItem === "map") {
        const mapDuration = Array.isArray(template.durations)
          ? template.durations[i]
          : template.durations["map"];
        if (mapDuration === undefined) {
          throw new Error(`Duration not found for map video at position ${i}`);
        }
        clips.push({
          path: mapVideoPath!,
          duration: mapDuration,
        });
        continue;
      }

      const index = sequenceItem as number;
      const duration = usedDurations[i];
      if (duration === undefined) {
        throw new Error(`Duration not found for position ${i}`);
      }

      clips.push({
        path: inputVideos[index],
        duration,
        transition: template.transitions?.[i > 0 ? i - 1 : 0],
        colorCorrection: template.colorCorrection,
      });
    }

    if (clips.length !== adaptedSequence.length) {
      throw new Error("Failed to create all required clips");
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
