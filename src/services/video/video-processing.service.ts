/**
 * Video Processing Service
 *
 * Core service for video processing operations including composition,
 * encoding, and asset management. Provides low-level video manipulation
 * capabilities used by higher-level services.
 *
 * Features:
 * - Video composition and encoding
 * - Audio integration
 * - Frame rate management
 * - Quality control
 * - Resource cleanup
 *
 * Dependencies:
 * - ffmpeg for video processing
 * - Proper codec support (libx264, etc.)
 * - Sufficient disk space for temporary files
 *
 * @module VideoProcessingService
 */

import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { logger } from "../../utils/logger";
import { ReelTemplate } from "../imageProcessing/templates/types";

export interface VideoClip {
  path: string;
  duration: number;
  transition?: {
    type: "crossfade" | "fade" | "slide";
    duration: number;
  };
  colorCorrection?: {
    ffmpegFilter: string;
  };
  watermark?: {
    path: string;
    position?: {
      x: string; // Can be pixels or expressions like "(main_w-overlay_w)/2"
      y: string; // Can be pixels or expressions like "main_h-overlay_h-20"
    };
  };
}

export interface VideoProcessingOptions {
  music?: ReelTemplate;
  reverse?: boolean;
  transitions?: {
    type: "crossfade" | "fade" | "slide";
    duration: number;
  }[];
  colorCorrection?: {
    ffmpegFilter: string;
  };
}

export class VideoProcessingService {
  private static instance: VideoProcessingService;
  private readonly TEMP_DIR = process.env.TEMP_OUTPUT_DIR || "./temp";

  private constructor() {
    // Ensure temp directory exists
    if (!fs.existsSync(this.TEMP_DIR)) {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }

    // Setup periodic cleanup
    setInterval(() => this.cleanupStaleFiles(), 3600000); // Run every hour
  }

  private async cleanupStaleFiles() {
    try {
      const files = await fs.promises.readdir(this.TEMP_DIR);
      const now = Date.now();
      const TWO_HOURS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

      for (const file of files) {
        const filePath = path.join(this.TEMP_DIR, file);
        try {
          const stats = await fs.promises.stat(filePath);

          // Check if file is older than 2 hours
          if (now - stats.mtimeMs > TWO_HOURS) {
            // Check if it's a failed video (0 bytes) or a regular file
            if (stats.size === 0 || path.extname(file) === ".mp4") {
              await fs.promises.unlink(filePath);
              logger.info("Cleaned up stale file:", { filePath });
            }
          }
        } catch (error) {
          logger.error("Error checking file:", { file, error });
        }
      }
    } catch (error) {
      logger.error("Error during cleanup:", { error });
    }
  }

  public static getInstance(): VideoProcessingService {
    if (!VideoProcessingService.instance) {
      VideoProcessingService.instance = new VideoProcessingService();
    }
    return VideoProcessingService.instance;
  }

  public async stitchVideos(
    clipPaths: string[],
    durations: number[],
    outputPath: string,
    template?: ReelTemplate & {
      watermark?: {
        path: string;
        position?: {
          x: string;
          y: string;
        };
      };
    }
  ): Promise<void> {
    if (clipPaths.length === 0) {
      throw new Error("No input files provided");
    }

    if (clipPaths.length !== durations.length) {
      throw new Error("Number of input files must match number of durations");
    }

    const command = ffmpeg();

    // Add input clips
    clipPaths.forEach((path) => {
      command.input(path);
    });

    // Add music track if available
    let musicIndex = -1;
    if (template?.music?.path) {
      try {
        await fsPromises.access(template.music.path, fs.constants.R_OK);
        musicIndex = clipPaths.length;
        command.input(template.music.path);
      } catch (error) {
        logger.warn("Music file not accessible:", {
          path: template.music.path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Add watermark if configured
    let watermarkIndex = -1;
    if (template?.watermark?.path) {
      try {
        await fsPromises.access(template.watermark.path, fs.constants.R_OK);
        watermarkIndex = musicIndex !== -1 ? musicIndex + 1 : clipPaths.length;
        command.input(template.watermark.path);
        logger.info("Added watermark input:", {
          path: template.watermark.path,
          inputIndex: watermarkIndex
        });
      } catch (error) {
        logger.warn("Watermark file not accessible:", {
          path: template.watermark.path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Create filter complex commands
    const filterCommands = [];

    // Process each clip with scaling and padding
    for (let i = 0; i < clipPaths.length; i++) {
      // Scale all videos to 768x1280 to match map zoom video dimensions
      filterCommands.push({
        filter: "scale",
        options: "768:1280:force_original_aspect_ratio=decrease",
        inputs: [`${i}:v`],
        outputs: [`scaled${i}`],
      });

      // Add padding to maintain aspect ratio
      filterCommands.push({
        filter: "pad",
        options: "768:1280:(ow-iw)/2:(oh-ih)/2",
        inputs: [`scaled${i}`],
        outputs: [`padded${i}`],
      });

      // Add contrast and color adjustments
      filterCommands.push({
        filter: "eq",
        options: "contrast=0.9:brightness=0.05:saturation=0.95",
        inputs: [`padded${i}`],
        outputs: [`eq${i}`],
      });

      // Set presentation timestamp (PTS) for proper timing
      filterCommands.push({
        filter: "setpts",
        options: "PTS-STARTPTS",
        inputs: [`eq${i}`],
        outputs: [`pts${i}`],
      });
    }

    // Add concat filter for video
    filterCommands.push({
      filter: "concat",
      options: `n=${clipPaths.length}:v=1:a=0`,
      inputs: clipPaths.map((_, i) => `pts${i}`),
      outputs: ["concat"],
    });

    // Add watermark if available
    if (watermarkIndex !== -1) {
      const position = template?.watermark?.position || {
        x: "(main_w-overlay_w)/2",
        y: "main_h-overlay_h-20"
      };
      
      filterCommands.push({
        filter: "overlay",
        options: `${position.x}:${position.y}`,
        inputs: ["concat", `${watermarkIndex}:v`],
        outputs: ["outv"],
      });
    } else {
      // If no watermark, rename concat output to outv
      filterCommands.push({
        filter: "null",
        inputs: ["concat"],
        outputs: ["outv"],
      });
    }

    // Process audio if available
    if (musicIndex !== -1) {
      const totalDuration = durations.reduce((sum, d) => sum + d, 0);
      const volume = template?.music?.volume || 0.8;
      const startTime = template?.music?.startTime || 0;
      const fadeStart = Math.max(0, totalDuration - 1);

      filterCommands.push({
        filter: "aformat",
        options: "sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
        inputs: [`${musicIndex}:a`],
        outputs: ["a1"],
      });

      if (startTime > 0) {
        filterCommands.push({
          filter: "atrim",
          options: `start=${startTime}`,
          inputs: ["a1"],
          outputs: ["a1_trimmed"],
        });
      }

      filterCommands.push({
        filter: "atrim",
        options: `duration=${totalDuration}`,
        inputs: [startTime > 0 ? "a1_trimmed" : "a1"],
        outputs: ["a2"],
      });

      filterCommands.push({
        filter: "volume",
        options: `${volume}:eval=frame`,
        inputs: ["a2"],
        outputs: ["a3"],
      });

      filterCommands.push({
        filter: "afade",
        options: `t=out:st=${fadeStart}:d=1`,
        inputs: ["a3"],
        outputs: ["outa"],
      });
    }

    // Apply filter complex
    command.complexFilter(filterCommands);

    // Set output options with high quality settings
    const outputOptions = [
      "-map",
      "[outv]",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-r",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-level",
      "4.0",
      "-movflags",
      "+faststart",
    ];

    if (musicIndex !== -1) {
      outputOptions.push(
        "-map",
        "[outa]",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest"
      );
    }

    command.outputOptions(outputOptions);

    // Execute the command
    return new Promise<void>((resolve, reject) => {
      command
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }

  public async batchProcessVideos(
    inputVideos: string[],
    outputPath: string,
    options: VideoProcessingOptions = {}
  ): Promise<void> {
    console.log("Starting batch video processing with:", {
      videoCount: inputVideos.length,
      outputPath,
      hasMusicTrack: !!options.music,
      reverse: options.reverse,
    });

    // Create a temporary directory for intermediate files
    const tempDir = path.join(
      process.env.TEMP_OUTPUT_DIR || "./temp",
      "batch_" + Date.now()
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    try {
      // Process videos in parallel batches
      const batchSize = 3; // Process 3 videos at a time
      const batches = [];

      for (let i = 0; i < inputVideos.length; i += batchSize) {
        const batch = inputVideos.slice(i, i + batchSize);
        batches.push(batch);
      }

      // Process each batch
      for (const [index, batch] of batches.entries()) {
        console.log(`Processing batch ${index + 1}/${batches.length}`);
        await Promise.all(
          batch.map(async (video, idx) => {
            const outputFile = path.join(tempDir, `processed_${idx}.mp4`);
            await this.stitchVideos(
              [video],
              [5], // Default duration
              outputFile,
              options.music
            );
            return outputFile;
          })
        );
      }

      // Get all processed videos
      const processedFiles = await fs.promises.readdir(tempDir);
      const processedPaths = processedFiles
        .filter((file) => file.startsWith("processed_"))
        .map((file) => path.join(tempDir, file))
        .sort((a, b) => {
          const aNum = parseInt(a.match(/processed_(\d+)\.mp4/)?.[1] || "0");
          const bNum = parseInt(b.match(/processed_(\d+)\.mp4/)?.[1] || "0");
          return aNum - bNum;
        });

      // Final concatenation of all processed videos
      await this.stitchVideos(
        processedPaths,
        processedPaths.map(() => 5), // Default duration for each segment
        outputPath,
        options.music
      );
    } finally {
      // Cleanup temporary files
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error("Error cleaning up temporary files:", error);
      }
    }
  }

  async createVideoFromClips(
    clips: VideoClip[],
    outputPath: string,
    template?: ReelTemplate
  ): Promise<void> {
    return this.stitchVideos(
      clips.map((c) => c.path),
      clips.map((c) => c.duration),
      outputPath,
      template
    );
  }

  async processClips(
    clips: VideoClip[],
    outputPath: string,
    template?: ReelTemplate
  ): Promise<void> {
    return this.createVideoFromClips(clips, outputPath, template);
  }

  async extractFrame(
    inputPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<void> {
    await ffmpeg(inputPath).screenshots({
      timestamps: [timestamp],
      filename: path.basename(outputPath),
      folder: path.dirname(outputPath),
    });
  }
}

// Export singleton instance
export const videoProcessingService = VideoProcessingService.getInstance();
