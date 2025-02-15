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
  ReelTemplate,
  reelTemplates,
  TemplateKey,
} from "../imageProcessing/templates/types";
import { VideoClip } from "./video-processing.service";
import { promises as fsPromises } from "fs";

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

    // Validate template exists
    const template = reelTemplates[templateKey];
    if (!template) {
      logger.error("Template not found", { templateKey });
      throw new Error(`Template ${templateKey} not found`);
    }

    // Resolve music path if present and update template
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

    // Count how many actual image slots we need (excluding map)
    const imageSlots = template.sequence.filter((s) => s !== "map").length;
    const availableImages = inputVideos.length;

    logger.info("Template analysis", {
      totalSlots: template.sequence.length,
      imageSlots,
      availableImages,
      hasMapVideo: !!mapVideoPath,
    });

    // If we have fewer images than slots, adapt the sequence
    let adaptedSequence = [...template.sequence];
    if (availableImages < imageSlots) {
      // Keep the map and reuse available images in a round-robin fashion
      adaptedSequence = template.sequence.map((item) => {
        if (item === "map") return item;
        const index = typeof item === "number" ? item : parseInt(item);
        return index % availableImages; // Use modulo to wrap around available images
      });

      logger.info("Adapted sequence for fewer images", {
        originalLength: template.sequence.length,
        adaptedLength: adaptedSequence.length,
        sequence: adaptedSequence,
        availableImages,
      });
    }

    const clips: VideoClip[] = [];
    for (const sequenceItem of adaptedSequence) {
      if (sequenceItem === "map") {
        if (!mapVideoPath) {
          logger.error("Map video required but not provided", { templateKey });
          throw new Error("Map video required but not provided");
        }
        const mapDuration =
          typeof template.durations === "object"
            ? (template.durations as Record<string, number>).map
            : (template.durations as number[])[0];
        clips.push({
          path: mapVideoPath,
          duration: mapDuration,
        });
      } else {
        const index =
          typeof sequenceItem === "number"
            ? sequenceItem
            : parseInt(sequenceItem);
        // Normalize the index to fit within available images
        const normalizedIndex = index % availableImages;
        const duration =
          typeof template.durations === "object"
            ? (template.durations as Record<string, number>)[String(index)]
            : (template.durations as number[])[clips.length];

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
        });
      }
    }

    // Validate we have all required clips
    if (clips.length !== adaptedSequence.length) {
      logger.error("Clip count mismatch", {
        expected: adaptedSequence.length,
        actual: clips.length,
      });
      throw new Error("Failed to create all required clips");
    }

    return clips;
  }
}

// Export singleton instance
export const videoTemplateService = VideoTemplateService.getInstance();
