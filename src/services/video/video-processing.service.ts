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
import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import { ReelTemplate } from "../imageProcessing/templates/types";
import {
  VideoTemplate,
  WatermarkConfig,
} from "../video/video-template.service";

interface FFmpegError extends Error {
  code?: string;
  exitCode?: number;
  ffmpegOutput?: string;
  killed?: boolean;
}

interface FFmpegProgress {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent?: number;
}

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
    if (!existsSync(this.TEMP_DIR)) {
      mkdirSync(this.TEMP_DIR, { recursive: true });
    }

    // Setup periodic cleanup
    setInterval(() => this.cleanupStaleFiles(), 3600000); // Run every hour
  }

  private async cleanupStaleFiles() {
    try {
      const files = await fs.readdir(this.TEMP_DIR);
      const now = Date.now();
      const TWO_HOURS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

      for (const file of files) {
        const filePath = path.join(this.TEMP_DIR, file);
        try {
          const stats = await fs.stat(filePath);

          // Check if file is older than 2 hours
          if (now - stats.mtimeMs > TWO_HOURS) {
            // Check if it's a failed video (0 bytes) or a regular file
            if (stats.size === 0 || path.extname(file) === ".mp4") {
              await fs.unlink(filePath);
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

  private handleFFmpegProgress(
    progress: FFmpegProgress,
    context: string
  ): void {
    const percent = progress.percent || 0;
    if (percent % 10 === 0) {
      logger.info(`[${context}] Processing progress:`, {
        percent: `${percent.toFixed(1)}%`,
        frames: progress.frames,
        fps: progress.currentFps,
        bitrate: `${progress.currentKbps}kbps`,
        timemark: progress.timemark,
      });
    }
  }

  private handleFFmpegError(error: FFmpegError, context: string): never {
    let errorMessage = error.message;
    const details: Record<string, unknown> = {
      code: error.code,
      exitCode: error.exitCode,
      killed: error.killed,
    };

    if (error.ffmpegOutput) {
      const outputLines = error.ffmpegOutput.split("\n");
      const errorLines = outputLines.filter((line) =>
        line.toLowerCase().includes("error")
      );
      if (errorLines.length > 0) {
        details.ffmpegErrors = errorLines;
        errorMessage = errorLines[errorLines.length - 1];
      }

      const codecLines = outputLines.filter(
        (line) =>
          line.includes("codec") ||
          line.includes("encoder") ||
          line.includes("decoder")
      );
      if (codecLines.length > 0) {
        details.codecIssues = codecLines;
      }

      const fileLines = outputLines.filter(
        (line) =>
          line.includes("No such file") ||
          line.includes("Invalid data") ||
          line.includes("Error opening")
      );
      if (fileLines.length > 0) {
        details.fileIssues = fileLines;
      }
    }

    logger.error(`[${context}] FFmpeg error:`, {
      error: errorMessage,
      ...details,
    });

    throw new Error(`FFmpeg error in ${context}: ${errorMessage}`);
  }

  private createFFmpegCommand(context: string): ffmpeg.FfmpegCommand {
    return ffmpeg()
      .on("start", (command) => {
        logger.info(`[${context}] Starting FFmpeg command:`, { command });
      })
      .on("progress", (progress) =>
        this.handleFFmpegProgress(progress as FFmpegProgress, context)
      )
      .on("end", () => {
        logger.info(`[${context}] FFmpeg processing completed`);
      })
      .on("error", (error: FFmpegError) =>
        this.handleFFmpegError(error, context)
      );
  }

  private async validateFile(
    filePath: string,
    context: string = "file"
  ): Promise<void> {
    try {
      await fs.access(filePath, fs.constants.R_OK);
      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        throw new Error(`${context} is empty: ${filePath}`);
      }
    } catch (error) {
      throw new Error(
        `${context} not accessible: ${filePath} - ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  public async stitchVideos(
    clips: VideoClip[],
    outputPath: string,
    template: VideoTemplate,
    watermarkConfig?: WatermarkConfig
  ): Promise<void> {
    const context = `stitchVideos:${path.basename(outputPath)}`;
    const inputPaths = clips.map((clip) => clip.path);
    const durations = clips.map((clip) => clip.duration);

    try {
      // Validate inputs
      if (inputPaths.length === 0) {
        throw new Error("No input files provided");
      }

      if (inputPaths.length !== clips.length) {
        throw new Error("Number of input files must match number of clips");
      }

      // Validate input files
      await Promise.all(
        inputPaths.map((filePath) => this.validateFile(filePath, "Input video"))
      );

      // Verify watermark if provided
      if (watermarkConfig) {
        try {
          await this.validateFile(watermarkConfig.path, "Watermark");
        } catch (error) {
          logger.warn(
            "Watermark file not accessible, continuing without watermark",
            {
              path: watermarkConfig.path,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
          watermarkConfig = undefined;
        }
      }

      // Create FFmpeg command with error handling
      const command = this.createFFmpegCommand(context);

      // Add input clips
      inputPaths.forEach((path) => {
        command.input(path);
      });

      // Add music track if available
      let musicIndex = -1;
      if (template?.music?.path) {
        try {
          await fs.access(template.music.path, fs.constants.R_OK);
          musicIndex = inputPaths.length;
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
      if (watermarkConfig) {
        try {
          await fs.access(watermarkConfig.path, fs.constants.R_OK);
          watermarkIndex =
            musicIndex !== -1 ? musicIndex + 1 : inputPaths.length;
          command.input(watermarkConfig.path);
          logger.info("Added watermark input:", {
            path: watermarkConfig.path,
            inputIndex: watermarkIndex,
          });
        } catch (error) {
          logger.warn("Watermark file not accessible:", {
            path: watermarkConfig.path,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      // Configure output
      command.videoCodec("libx264").outputOptions([
        "-pix_fmt yuv420p", // Ensure compatibility
        "-movflags +faststart", // Enable streaming
        "-preset veryslow", // Best compression
        "-crf 23", // High quality
      ]);

      // Apply template-specific settings
      if (template.outputOptions) {
        command.outputOptions(template.outputOptions);
      }

      // Build complex filter
      const filterGraph = this.buildFilterGraph(clips, watermarkConfig);
      if (filterGraph) {
        command.complexFilter(filterGraph);
      }

      // Execute FFmpeg command with proper error handling
      await new Promise<void>((resolve, reject) => {
        command
          .save(outputPath)
          .on("end", async () => {
            try {
              await this.validateFile(outputPath, "Output video");
              resolve();
            } catch (error) {
              reject(error);
            }
          })
          .on("error", (error: FFmpegError) => {
            reject(error);
          });
      });

      logger.info(`[${context}] Video processing completed successfully`, {
        outputPath,
        inputCount: inputPaths.length,
        totalDuration: durations.reduce((sum: number, d: number) => sum + d, 0),
        hasWatermark: !!watermarkConfig,
      });
    } catch (error) {
      if (!(error instanceof Error && "ffmpegOutput" in error)) {
        throw new Error(
          `Failed to process video: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
      this.handleFFmpegError(error as FFmpegError, context);
    }
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
    await fs.mkdir(tempDir, { recursive: true });

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
            // Convert simple video paths to VideoClip objects
            const processedClips = [
              {
                path: video,
                duration: 5, // Default duration
                // Add any other required VideoClip properties
              },
            ];

            await this.stitchVideos(processedClips, outputFile, {
              music: options.music,
            } as VideoTemplate);
            return outputFile;
          })
        );
      }

      // Get all processed videos
      const processedFiles = await fs.readdir(tempDir);
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
        processedPaths.map((path) => ({
          path,
          duration: 5, // Default duration
        })),
        outputPath,
        { music: options.music } as VideoTemplate
      );
    } finally {
      // Cleanup temporary files
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
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
    return this.stitchVideos(clips, outputPath, {
      music: template,
    } as VideoTemplate);
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

  private buildFilterGraph(
    clips: VideoClip[],
    watermarkConfig?: WatermarkConfig
  ): ffmpeg.FilterSpecification[] | null {
    if (!clips.length) return null;

    const filterCommands: ffmpeg.FilterSpecification[] = [];
    let lastOutput = "";

    // Process each clip
    clips.forEach((clip, i) => {
      // Scale and pad
      filterCommands.push({
        filter: "scale",
        options: "768:1280:force_original_aspect_ratio=decrease",
        inputs: [`${i}:v`],
        outputs: [`scaled${i}`],
      });

      filterCommands.push({
        filter: "pad",
        options: "768:1280:(ow-iw)/2:(oh-ih)/2",
        inputs: [`scaled${i}`],
        outputs: [`padded${i}`],
      });

      // Apply color correction
      const colorFilter =
        clip.colorCorrection?.ffmpegFilter ||
        "eq=contrast=0.9:brightness=0.05:saturation=0.95";
      filterCommands.push({
        filter: colorFilter.startsWith("eq=")
          ? colorFilter.substring(3)
          : colorFilter,
        inputs: [`padded${i}`],
        outputs: [`color${i}`],
      });

      // Handle transition from previous clip if exists
      if (i > 0 && clip.transition) {
        const { type, duration } = clip.transition;
        switch (type) {
          case "crossfade":
            filterCommands.push({
              filter: "xfade",
              options: `transition=fade:duration=${duration}`,
              inputs: [lastOutput, `color${i}`],
              outputs: [`trans${i}`],
            });
            lastOutput = `trans${i}`;
            break;
          case "fade":
            filterCommands.push({
              filter: "fade",
              options: `t=out:st=${
                clips[i - 1].duration - duration
              }:d=${duration}`,
              inputs: [lastOutput],
              outputs: [`fadeout${i}`],
            });
            filterCommands.push({
              filter: "fade",
              options: `t=in:st=0:d=${duration}`,
              inputs: [`color${i}`],
              outputs: [`fadein${i}`],
            });
            filterCommands.push({
              filter: "concat",
              options: "n=2:v=1:a=0",
              inputs: [`fadeout${i}`, `fadein${i}`],
              outputs: [`trans${i}`],
            });
            lastOutput = `trans${i}`;
            break;
          case "slide":
            // Implement slide transition
            filterCommands.push({
              filter: "xfade",
              options: `transition=slideleft:duration=${duration}`,
              inputs: [lastOutput, `color${i}`],
              outputs: [`trans${i}`],
            });
            lastOutput = `trans${i}`;
            break;
        }
      } else {
        lastOutput = `color${i}`;
      }
    });

    // If we have multiple clips without transitions, concatenate them
    if (clips.length > 1 && !clips.some((clip) => clip.transition)) {
      filterCommands.push({
        filter: "concat",
        options: `n=${clips.length}:v=1:a=0`,
        inputs: clips.map((_, i) => `color${i}`),
        outputs: ["concat"],
      });
      lastOutput = "concat";
    }

    // Add watermark if provided
    if (watermarkConfig) {
      const position = watermarkConfig.position || {
        x: "(main_w-overlay_w)/2",
        y: "main_h-overlay_h-20",
      };
      filterCommands.push({
        filter: "overlay",
        options: `${position.x}:${position.y}`,
        inputs: [lastOutput, "watermark"],
        outputs: ["watermarked"],
      });
      lastOutput = "watermarked";
    }

    // Ensure we have a final output named 'outv'
    if (lastOutput !== "outv") {
      filterCommands.push({
        filter: "null",
        inputs: [lastOutput],
        outputs: ["outv"],
      });
    }

    return filterCommands;
  }
}

// Export singleton instance
export const videoProcessingService = VideoProcessingService.getInstance();
