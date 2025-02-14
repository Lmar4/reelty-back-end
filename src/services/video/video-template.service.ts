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

import { VideoClip } from "./video-processing.service";
import { reelTemplates } from "../imageProcessing/templates/types";
import { TemplateKey } from "../imageProcessing/templates/types";
import { logger } from "../../utils/logger";
import * as path from "path";

export interface VideoTemplate {
  duration: 5 | 10; // Only 5 or 10 seconds allowed
  ratio?: "1280:768" | "768:1280"; // Only these aspect ratios allowed
  watermark?: boolean; // Optional watermark flag
  headers?: {
    [key: string]: string;
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

    // Resolve music path if present
    if (template.music?.path) {
      const musicPath = path.join(process.cwd(), template.music.path);
      logger.info("Resolved music path", {
        original: template.music.path,
        resolved: musicPath,
      });
    }

    return clips;
  }

  public validateTemplate(template: VideoTemplate): void {
    if (template.duration !== 5 && template.duration !== 10) {
      throw new Error("Invalid duration. Must be 5 or 10 seconds.");
    }

    if (
      template.ratio &&
      template.ratio !== "1280:768" &&
      template.ratio !== "768:1280"
    ) {
      throw new Error('Invalid ratio. Must be "1280:768" or "768:1280".');
    }
  }
}

// Export singleton instance
export const videoTemplateService = VideoTemplateService.getInstance();
