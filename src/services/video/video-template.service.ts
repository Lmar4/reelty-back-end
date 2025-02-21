/**
 * Video Template Service
 *
 * Handles the generation of video content based on predefined templates.
 * Manages template processing, asset integration, and video composition.
 *
 * Features:
 * - Template-based video generation
 * - Asset management (images, maps, music)
 * - Video composition with ffmpeg
 * - Error handling and retry mechanisms
 *
 * @module VideoTemplateService
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import {
  reelTemplates,
  TemplateKey,
  ReelTemplate,
} from "../imageProcessing/templates/types";
import { VideoClip, videoProcessingService } from "./video-processing.service";

interface MusicConfig {
  path: string;
  volume?: number;
  startTime?: number;
}

interface WatermarkConfig {
  path: string;
  position?: {
    x: string; // Can be pixels or expressions like "(main_w-overlay_w)/2"
    y: string; // Can be pixels or expressions like "main_h-overlay_h-20"
  };
}

export class VideoTemplateService {
  private static instance: VideoTemplateService;

  private constructor() {}

  public static getInstance(): VideoTemplateService {
    if (!VideoTemplateService.instance) {
      VideoTemplateService.instance = new VideoTemplateService();
    }
    return VideoTemplateService.instance;
  }

  /**
   * Resolves the music file path by checking multiple possible locations
   * @param musicPath - The original music path from the template
   * @returns The resolved absolute path if found, null otherwise
   */
  private async resolveAssetPath(
    assetPath: string,
    type: "music" | "watermark"
  ): Promise<string | null> {
    // Define possible locations to check
    const basePaths = [
      path.join(process.cwd(), "public"),
      process.cwd(),
      path.join(process.cwd(), "assets", type),
      path.join(__dirname, "../../../public"),
      path.join(__dirname, "../../../"),
      path.join(__dirname, `../../../assets/${type}`),
    ];

    const possiblePaths = basePaths.map((base) =>
      path.join(base, path.basename(assetPath))
    );

    logger.info("Checking possible asset file locations", {
      originalPath: assetPath,
      searchPaths: possiblePaths,
    });

    // Try each path in sequence
    for (const possiblePath of possiblePaths) {
      try {
        await fs.promises.access(possiblePath, fs.constants.R_OK);
        logger.info("Found asset file", {
          originalPath: assetPath,
          resolvedPath: possiblePath,
        });
        return possiblePath;
      } catch (error) {
        logger.debug("Asset file not found at path", {
          path: possiblePath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    logger.warn("Asset file not found in any location", {
      originalPath: assetPath,
      searchedPaths: possiblePaths,
    });
    return null;
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

    // Validate sequence
    if (!template.sequence.length) {
      throw new Error("Template sequence cannot be empty");
    }

    // Validate durations
    if (
      !template.durations ||
      (Array.isArray(template.durations) && !template.durations.length)
    ) {
      throw new Error("Template must have valid durations");
    }

    // Resolve music path if present
    if (template.music?.path) {
      const resolvedMusicPath = await this.resolveAssetPath(
        template.music.path,
        "music"
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
        logger.warn("No valid music file found, proceeding without music", {
          originalPath: template.music.path,
        });
      }
    }

    // Handle watermark if needed
    let watermarkConfig: WatermarkConfig | undefined;
    if (options?.watermark) {
      const watermarkPath = await this.resolveAssetPath(
        "reelty_watermark.png",
        "watermark"
      );

      if (watermarkPath) {
        watermarkConfig = {
          path: watermarkPath,
          position: {
            x: "(main_w-overlay_w)/2",
            y: "main_h-overlay_h-20",
          },
        };
        logger.info("Watermark resolved and will be applied", {
          path: watermarkPath,
        });
      } else {
        logger.warn("Watermark requested but file not found");
      }
    }

    // Count how many actual video slots we need (excluding map)
    const videoSlots = template.sequence.filter((s) => s !== "map").length;
    const availableVideos = inputVideos.length;
    const hasMapRequirement = template.sequence.includes("map");

    // Validate map video requirement
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

    // Keep only map markers and indices that exist in our input videos
    const adaptedSequence = template.sequence.filter((item) => {
      if (item === "map") return true;

      const index = typeof item === "number" ? item : parseInt(item);
      if (isNaN(index)) {
        logger.warn("Invalid sequence item, skipping", { item });
        return false;
      }

      // Only keep indices that are within our available videos
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

    // Track which durations we'll actually use
    const usedDurations = adaptedSequence.map((_, i) => {
      // For array-style durations, use the original sequence position
      if (Array.isArray(template.durations)) {
        return template.durations[i];
      }
      // For object-style durations, use the sequence item itself
      return template.durations[adaptedSequence[i]];
    });

    logger.info("Adapted sequence and durations", {
      originalSequence: template.sequence,
      adaptedSequence,
      originalDurations: template.durations,
      usedDurations,
      availableVideos,
    });

    logger.info("Filtered sequence to available videos", {
      originalLength: template.sequence.length,
      filteredLength: adaptedSequence.length,
      sequence: adaptedSequence,
      availableVideos,
    });

    // Create clips with proper duration handling
    const clips: VideoClip[] = [];
    for (let i = 0; i < adaptedSequence.length; i++) {
      const sequenceItem = adaptedSequence[i];

      if (sequenceItem === "map") {
        // Get map duration from template
        const mapDuration = Array.isArray(template.durations)
          ? template.durations[i]
          : template.durations["map"];

        if (mapDuration === undefined) {
          logger.error("Map duration not found", {
            position: i,
            durations: template.durations,
          });
          throw new Error(`Duration not found for map video at position ${i}`);
        }

        clips.push({
          path: mapVideoPath!,
          duration: mapDuration,
        });
        continue;
      }

      const index = sequenceItem as number;

      // Use exact index from sequence (we've already filtered invalid ones)
      // Get exact duration for this index from template
      // Use the pre-calculated duration that matches our adapted sequence
      const duration = usedDurations[i];
      if (duration === undefined) {
        logger.error("Duration not found in adapted sequence", {
          index,
          position: i,
          adaptedSequence,
          usedDurations,
        });
        throw new Error(
          `Duration not found for adapted sequence position ${i}`
        );
      }

      clips.push({
        path: inputVideos[index],
        duration,
        transition: template.transitions?.[i > 0 ? i - 1 : 0],
        colorCorrection: template.colorCorrection,
      });
    }

    // Final validation
    if (clips.length !== adaptedSequence.length) {
      logger.error("Clip count mismatch", {
        expected: adaptedSequence.length,
        actual: clips.length,
      });
      throw new Error("Failed to create all required clips");
    }

    return clips;
  }

  async extractThumbnail(videoPath: string): Promise<string> {
    const outputPath = path.join(
      process.env.TEMP_DIR || "./temp",
      `thumbnail-${Date.now()}.webp`
    );

    // Extract frame and convert to WebP format
    await videoProcessingService.extractFrame(videoPath, outputPath, 1); // Extract frame at 1 second
    return outputPath;
  }
}

// Export singleton instance
export const videoTemplateService = VideoTemplateService.getInstance();
