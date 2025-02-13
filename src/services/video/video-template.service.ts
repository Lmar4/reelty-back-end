import { VideoClip } from "./video-processing.service";
import { reelTemplates } from "../imageProcessing/templates/types";
import { TemplateKey } from "../imageProcessing/templates/types";

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
    console.log(
      "Creating template",
      templateKey,
      "with",
      inputVideos.length,
      "videos..."
    );

    const template = reelTemplates[templateKey];
    if (!template) {
      throw new Error(`Template ${templateKey} not found`);
    }

    // Count how many actual image slots we need (excluding map)
    const imageSlots = template.sequence.filter((s) => s !== "map").length;
    const availableImages = inputVideos.length;

    console.log("Template analysis:", {
      totalSlots: template.sequence.length,
      imageSlots,
      availableImages,
      hasMapVideo: !!mapVideoPath,
    });

    // If we have fewer images than slots, adapt the sequence
    let adaptedSequence = [...template.sequence];
    if (availableImages < imageSlots) {
      // Keep the map and use available images in a round-robin fashion
      adaptedSequence = template.sequence.filter((item) => {
        if (item === "map") return true;
        const index = typeof item === "number" ? item : parseInt(item);
        return index < availableImages;
      });

      console.log("Adapted sequence for fewer images:", {
        originalLength: template.sequence.length,
        adaptedLength: adaptedSequence.length,
        sequence: adaptedSequence,
      });
    }

    const clips: VideoClip[] = [];
    for (const sequenceItem of adaptedSequence) {
      if (sequenceItem === "map") {
        if (!mapVideoPath) {
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
        clips.push({
          path: inputVideos[normalizedIndex],
          duration,
        });
      }
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
