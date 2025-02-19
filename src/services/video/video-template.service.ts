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
  private async resolveMusicPath(musicPath: string): Promise<string | null> {
    // Define possible locations to check
    const possiblePaths = [
      path.join(process.cwd(), "public", musicPath),
      path.join(process.cwd(), musicPath),
      path.join(process.cwd(), "assets", "music", path.basename(musicPath)),
      path.join(__dirname, "../../../public", musicPath),
      path.join(__dirname, "../../../", musicPath),
      path.join(__dirname, "../../../assets/music", path.basename(musicPath)),
    ];

    logger.info("Checking possible music file locations", {
      originalPath: musicPath,
      searchPaths: possiblePaths,
    });

    // Try each path in sequence
    for (const possiblePath of possiblePaths) {
      try {
        await fs.promises.access(possiblePath, fs.constants.R_OK);
        logger.info("Found music file", {
          originalPath: musicPath,
          resolvedPath: possiblePath,
        });
        return possiblePath;
      } catch (error) {
        logger.debug("Music file not found at path", {
          path: possiblePath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    logger.warn("Music file not found in any location", {
      originalPath: musicPath,
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
    mapVideoPath?: string
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
      const resolvedMusicPath = await this.resolveMusicPath(
        template.music.path
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

    // If we have fewer videos than slots, adapt the sequence
    let adaptedSequence = [...template.sequence];
    if (availableVideos < videoSlots) {
      // Keep track of used indices and their frequencies
      const indexFrequency = new Map<number, number>();

      // First pass: Handle map markers and validate indices
      adaptedSequence = template.sequence.map((item) => {
        if (item === "map") return item;

        const rawIndex = typeof item === "number" ? item : parseInt(item);
        if (isNaN(rawIndex)) {
          logger.warn("Invalid sequence item, using fallback index 0", {
            item,
          });
          return 0;
        }
        return rawIndex;
      });

      // Second pass: Adapt sequence for available videos
      adaptedSequence = adaptedSequence.map((item) => {
        if (item === "map") return item;

        const index = item as number;

        // Find the least used index within available range
        let adaptedIndex = 0;
        let minFrequency = Infinity;

        for (let i = 0; i < availableVideos; i++) {
          const freq = indexFrequency.get(i) || 0;
          if (freq < minFrequency) {
            minFrequency = freq;
            adaptedIndex = i;
          }
        }

        // Update frequency count
        indexFrequency.set(
          adaptedIndex,
          (indexFrequency.get(adaptedIndex) || 0) + 1
        );

        return adaptedIndex;
      });

      logger.info("Adapted sequence for fewer videos", {
        originalLength: template.sequence.length,
        adaptedLength: adaptedSequence.length,
        sequence: adaptedSequence,
        availableVideos,
        indexDistribution: Object.fromEntries(indexFrequency.entries()),
      });
    }

    // Create clips with proper duration handling
    const clips: VideoClip[] = [];
    for (let i = 0; i < adaptedSequence.length; i++) {
      const sequenceItem = adaptedSequence[i];

      if (sequenceItem === "map") {
        const mapDuration = this.getClipDuration(template.durations, "map", i);
        clips.push({
          path: mapVideoPath!,
          duration: mapDuration,
        });
        continue;
      }

      const index = sequenceItem as number;
      const normalizedIndex = Math.abs(index) % availableVideos;

      // Get duration with fallback handling
      const duration = this.getClipDuration(template.durations, index, i);

      // Validate video path exists
      if (!inputVideos[normalizedIndex]) {
        logger.error("Video not found at index", {
          index: normalizedIndex,
          totalVideos: inputVideos.length,
        });
        throw new Error(`Video not found at index ${normalizedIndex}`);
      }

      clips.push({
        path: inputVideos[normalizedIndex],
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

  /**
   * Helper method to safely get clip duration with fallbacks
   */
  private getClipDuration(
    durations: number[] | Record<string | number, number>,
    index: number | string,
    position: number
  ): number {
    const DEFAULT_DURATION = 2.0; // Fallback duration in seconds

    try {
      if (Array.isArray(durations)) {
        // For array durations, use position as fallback
        return durations[position] || durations[0] || DEFAULT_DURATION;
      } else {
        // For object durations, use index as key with fallbacks
        return durations[index] || durations[0] || DEFAULT_DURATION;
      }
    } catch (error) {
      logger.warn("Error getting clip duration, using default", {
        error,
        index,
        position,
        defaultDuration: DEFAULT_DURATION,
      });
      return DEFAULT_DURATION;
    }
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
