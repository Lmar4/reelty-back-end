import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import { createReadStream } from "fs";
import * as path from "path";
import { logger } from "../../utils/logger.js";
import { S3Service } from "../storage/s3.service.js";
import { ReelTemplate } from "../imageProcessing/templates/types.js";
import {
  VideoTemplate,
  WatermarkConfig,
} from "../video/video-template.service.js";
import { exec } from "child_process";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import { EventEmitter } from "events";
import { VideoValidationService } from "./video-validation.service.js";
import { S3VideoService } from "./s3-video.service.js";

interface FFmpegError extends Error {
  code?: string;
  exitCode?: number;
  ffmpegOutput?: string;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
  cmd?: string;
  spawnargs?: string[];
  details?: {
    input?: string[];
    output?: string;
    filters?: string[];
    errorAt?: string;
  };
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
      x: string;
      y: string;
    };
  };
}

interface VideoProcessingOptions {
  music?: { path: string; volume?: number; startTime?: number };
  reverse?: boolean;
  transitions?: {
    type: "crossfade" | "fade" | "slide";
    duration: number;
  }[];
  colorCorrection?: {
    ffmpegFilter: string;
  };
}

interface StitchOptions {
  outputOptions?: string[];
}

interface SlideshowOptions {
  slideDuration?: number;
  outputOptions?: string[];
}

interface TimelapseOptions {
  fps?: number;
  outputOptions?: string[];
}

interface GifOptions {
  frameDuration?: number;
  outputOptions?: string[];
}

export class VideoProcessingService {
  private static instance: VideoProcessingService;
  private static activeFFmpegCount = 0; // Global FFmpeg process counter
  private static readonly MAX_GLOBAL_FFMPEG = parseInt(
    process.env.MAX_GLOBAL_FFMPEG || "4",
    10
  ); // Global limit

  private readonly TEMP_DIR = process.env.TEMP_OUTPUT_DIR || "./temp";
  private s3Service: S3Service;
  private s3VideoService: S3VideoService;
  private videoValidationService: VideoValidationService;
  private readonly FFmpeg_TIMEOUT = 60 * 60 * 1000; // 1 hour timeout
  private activeFFmpegJobs = 0;
  private readonly MAX_CONCURRENT_JOBS = parseInt(
    process.env.MAX_CONCURRENT_FFMPEG_JOBS || "2",
    10
  );
  private ffmpegQueue: Array<() => Promise<void>> = [];
  private processingLock = false;

  // Add a private property to cache the codec
  private _cachedCodec: string | null = null;

  private constructor() {
    this.s3Service = new S3Service();
    this.s3VideoService = S3VideoService.getInstance();
    this.videoValidationService = VideoValidationService.getInstance();
    if (!existsSync(this.TEMP_DIR)) {
      mkdirSync(this.TEMP_DIR, { recursive: true });
      logger.info("Created TEMP_DIR", { path: this.TEMP_DIR });
    }

    // Start the queue processor
    this.processFFmpegQueue();

    // Add uncaught exception handler for cleanup
    process.on("uncaughtException", async (error) => {
      logger.error(
        "Uncaught exception in VideoProcessingService, cleaning up resources",
        {
          error: error instanceof Error ? error.message : String(error),
          activeJobs: this.activeFFmpegJobs,
          globalFFmpegCount: VideoProcessingService.activeFFmpegCount,
        }
      );

      // Attempt to clean up temp directory
      try {
        await fs.rm(this.TEMP_DIR, { recursive: true, force: true });
        logger.info("Successfully cleaned up temp directory after crash");
      } catch (cleanupError) {
        logger.error("Failed to clean up temp directory after crash", {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      }

      // Don't exit process here as it might be handling multiple requests
    });
  }

  public static getInstance(): VideoProcessingService {
    if (!VideoProcessingService.instance) {
      VideoProcessingService.instance = new VideoProcessingService();
    }
    return VideoProcessingService.instance;
  }

  private async checkFFmpegVersion(): Promise<void> {
    return new Promise((resolve, reject) => {
      exec("ffmpeg -version", (error: Error | null, stdout: string) => {
        if (error) {
          logger.error("Failed to get FFmpeg version", { error });
          reject(error);
          return;
        }

        const versionMatch = stdout.match(/version\s+([\d.]+)/);
        const version = versionMatch ? versionMatch[1] : "unknown";
        const hasLibx264 = stdout.includes("--enable-libx264");
        const hasLibmp3lame = stdout.includes("--enable-libmp3lame");
        const hasNvenc = stdout.includes("--enable-nvenc");
        const hasVideotoolbox = stdout.includes("--enable-videotoolbox");

        logger.info("FFmpeg version check", {
          version,
          hasLibx264,
          hasLibmp3lame,
          hasNvenc,
          hasVideotoolbox,
        });

        if (!hasLibx264 || !hasLibmp3lame) {
          logger.warn("FFmpeg missing required codecs", {
            missingLibx264: !hasLibx264,
            missingLibmp3lame: !hasLibmp3lame,
          });
        }

        resolve();
      });
    });
  }

  private async validateFile(
    filePath: string,
    context: string = "file"
  ): Promise<void> {
    try {
      // Use the new validation service
      await this.videoValidationService.validateVideo(filePath);
    } catch (error) {
      logger.error(`Failed to validate ${context}`, {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  private async resolveAssetPath(
    assetPath: string,
    type: "music" | "watermark" | "video",
    isRequired: boolean = false
  ): Promise<string> {
    logger.debug(`Resolving ${type} asset path`, { assetPath });
    if (assetPath.startsWith("https://")) {
      const localPath = path.join(
        this.TEMP_DIR,
        `temp_${crypto.randomUUID()}_${path.basename(assetPath)}`
      );
      const repairedPath = path.join(
        this.TEMP_DIR,
        `repaired_${crypto.randomUUID()}.mp4`
      );
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.s3Service.downloadFile(assetPath, localPath);
          await new Promise((r) => setTimeout(r, 500)); // Ensure file is written
          await fs.access(localPath, fs.constants.R_OK);

          // Repair file immediately after download
          await new Promise<void>((repairResolve, repairReject) => {
            ffmpeg(localPath)
              .outputOptions([
                "-c",
                "copy",
                "-map",
                "0",
                "-f",
                "mp4",
                "-moov_size",
                "1000000",
              ])
              .output(repairedPath)
              .on("end", () => {
                logger.info(`Repaired ${type} asset`, {
                  original: localPath,
                  repaired: repairedPath,
                });
                repairResolve();
              })
              .on("error", (repairErr) => {
                logger.warn(`Failed to repair ${type} asset, using original`, {
                  path: localPath,
                  error: repairErr.message,
                });
                repairResolve(); // Use original if repair fails
              })
              .run();
          });

          const finalPath = existsSync(repairedPath) ? repairedPath : localPath;
          const metadata = await this.videoValidationService.validateVideo(
            finalPath
          );
          if (
            type === "video" &&
            (!metadata.hasVideo || metadata.duration <= 0)
          ) {
            throw new Error(
              `Invalid ${type} file: no video stream or zero duration`
            );
          }
          if (
            type === "music" &&
            (!metadata.hasAudio || metadata.duration <= 0)
          ) {
            throw new Error(
              `Invalid ${type} file: no audio stream or zero duration`
            );
          }

          logger.info(`Downloaded and validated ${type} asset from S3`, {
            assetPath,
            finalPath,
            attempt,
          });
          return finalPath; // Cleanup deferred to stitchVideos
        } catch (error) {
          logger.warn(
            `Failed to download/repair ${type} asset, attempt ${attempt}/${maxRetries}`,
            {
              assetPath,
              localPath,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
          if (attempt === maxRetries) {
            throw new Error(
              `Failed to resolve ${type} asset after ${maxRetries} attempts: ${assetPath}`
            );
          }
          await fs.unlink(localPath).catch(() => {});
          await fs.unlink(repairedPath).catch(() => {});
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    try {
      await fs.access(assetPath, fs.constants.R_OK);
      const metadata = await this.videoValidationService.validateVideo(
        assetPath
      );
      if (type === "video" && (!metadata.hasVideo || metadata.duration <= 0)) {
        throw new Error(
          `Invalid local ${type} file: no video stream or zero duration`
        );
      }
      logger.debug(`Local ${type} asset verified`, { assetPath });
      return assetPath;
    } catch (error) {
      if (isRequired) {
        logger.error(`Required ${type} asset not found or invalid`, {
          assetPath,
          error,
        });
        throw new Error(
          `Required ${type} asset not found or invalid: ${assetPath}`
        );
      }
      logger.warn(`Optional ${type} asset not found or invalid, skipping`, {
        assetPath,
      });
      return "";
    }
  }

  private buildFilterGraph(
    clips: VideoClip[],
    watermarkConfig?: WatermarkConfig,
    musicIndex?: number,
    watermarkIndex?: number
  ): ffmpeg.FilterSpecification[] | null {
    if (!clips.length) {
      logger.warn("No clips provided for filter graph");
      return null;
    }

    const filterCommands: ffmpeg.FilterSpecification[] = [];
    let lastOutput = "";

    // Calculate total duration for audio trimming
    const totalDuration = clips.reduce(
      (sum, clip) => sum + (clip.duration || 0),
      0
    );

    logger.info("Building filter graph", {
      clipCount: clips.length,
      totalDuration,
      hasWatermark: !!watermarkConfig,
      hasMusic: musicIndex !== undefined && musicIndex !== -1,
    });

    clips.forEach((clip, i) => {
      const baseInput = `${i}:v`;
      const trimmedOutput = `trim${i}`;

      // First trim the clip to exact duration
      filterCommands.push({
        filter: "trim",
        options: `duration=${clip.duration}`,
        inputs: [baseInput],
        outputs: [trimmedOutput],
      });

      // Reset timestamps after trim
      filterCommands.push({
        filter: "setpts",
        options: "PTS-STARTPTS",
        inputs: [trimmedOutput],
        outputs: [`pts${i}`],
      });

      // Apply color correction - MODIFIED to handle complex filters
      let currentInput = `pts${i}`;
      let currentOutput = `color${i}`;

      if (clip.colorCorrection?.ffmpegFilter) {
        // Check if it's the wesanderson template (has curves filter)
        if (clip.colorCorrection.ffmpegFilter.includes("curves=master")) {
          // Split into individual filters for wesanderson template
          // Apply eq filter
          filterCommands.push({
            filter: "eq",
            options: "brightness=0.05:contrast=1.15:saturation=1.3:gamma=0.95",
            inputs: [currentInput],
            outputs: [`eq${i}`],
          });
          currentInput = `eq${i}`;

          // Apply hue filter
          filterCommands.push({
            filter: "hue",
            options: "h=5:s=1.2",
            inputs: [currentInput],
            outputs: [`hue${i}`],
          });
          currentInput = `hue${i}`;

          // Apply colorbalance filter
          filterCommands.push({
            filter: "colorbalance",
            options: "rm=0.1:gm=-0.05:bm=-0.1",
            inputs: [currentInput],
            outputs: [`cb${i}`],
          });
          currentInput = `cb${i}`;

          // Apply curves filter (without problematic quotes)
          filterCommands.push({
            filter: "curves",
            options: "master=0/0 0.2/0.15 0.5/0.55 0.8/0.85 1/1",
            inputs: [currentInput],
            outputs: [`curves${i}`],
          });
          currentInput = `curves${i}`;

          // Apply unsharp filter
          filterCommands.push({
            filter: "unsharp",
            options: "5:5:1.5:5:5:0.0",
            inputs: [currentInput],
            outputs: [currentOutput],
          });
        } else {
          // For other templates, use the standard approach with eq filter
          const filterOptions = clip.colorCorrection.ffmpegFilter.startsWith(
            "eq="
          )
            ? clip.colorCorrection.ffmpegFilter.substring(3)
            : clip.colorCorrection.ffmpegFilter;

          filterCommands.push({
            filter: filterOptions.startsWith("eq=") ? "eq" : "eq",
            options: filterOptions.startsWith("eq=")
              ? filterOptions.substring(3)
              : filterOptions,
            inputs: [currentInput],
            outputs: [currentOutput],
          });
        }
      } else {
        // Default color correction for clips without specific settings
        filterCommands.push({
          filter: "eq",
          options: "contrast=0.9:brightness=0.05:saturation=0.95",
          inputs: [currentInput],
          outputs: [currentOutput],
        });
      }

      // Handle transitions between clips
      if (i > 0 && clip.transition) {
        const { type, duration } = clip.transition;
        const transitionType = type === "slide" ? "crossfade" : type;
        filterCommands.push({
          filter: "xfade",
          options: `transition=${transitionType}:duration=${duration}`,
          inputs: [lastOutput, currentOutput],
          outputs: [`trans${i}`],
        });
        lastOutput = `trans${i}`;
      } else {
        lastOutput = currentOutput;
      }
    });

    // Concatenate all clips in smaller batches
    if (clips.length > 1) {
      const inputs = clips.map((_, i) =>
        i > 0 && clips[i].transition ? `trans${i}` : `color${i}`
      );

      // Use a smaller batch size for concatenation
      const MAX_CONCAT_INPUTS = 4; // Limit number of inputs per concat operation

      if (inputs.length <= MAX_CONCAT_INPUTS) {
        // If we have few enough clips, we can do a single concat
        filterCommands.push({
          filter: "concat",
          options: `n=${inputs.length}:v=1:a=0`,
          inputs,
          outputs: ["vconcat"],
        });
      } else {
        // Otherwise, do multiple concat operations in a cascade
        let remainingInputs = [...inputs];
        let concatStepCount = 0;
        let previousOutput = "";

        while (remainingInputs.length > 0) {
          const batchInputs = remainingInputs.splice(0, MAX_CONCAT_INPUTS);
          const isFirstBatch = concatStepCount === 0;
          const isLastBatch = remainingInputs.length === 0;
          const outputLabel = isLastBatch
            ? "vconcat"
            : `concat_step${concatStepCount}`;

          if (isFirstBatch) {
            // First batch just concatenates the first set of inputs
            filterCommands.push({
              filter: "concat",
              options: `n=${batchInputs.length}:v=1:a=0`,
              inputs: batchInputs,
              outputs: [outputLabel],
            });
          } else {
            // Subsequent batches concatenate previous result with next batch
            if (batchInputs.length > 1) {
              // If we have multiple inputs in this batch, concat them first
              const currentBatchOutput = `batch${concatStepCount}`;
              filterCommands.push({
                filter: "concat",
                options: `n=${batchInputs.length}:v=1:a=0`,
                inputs: batchInputs,
                outputs: [currentBatchOutput],
              });

              // Then concat with previous result
              filterCommands.push({
                filter: "concat",
                options: "n=2:v=1:a=0",
                inputs: [previousOutput, currentBatchOutput],
                outputs: [outputLabel],
              });
            } else {
              // If only one input in this batch, concat directly with previous result
              filterCommands.push({
                filter: "concat",
                options: "n=2:v=1:a=0",
                inputs: [previousOutput, batchInputs[0]],
                outputs: [outputLabel],
              });
            }
          }

          previousOutput = outputLabel;
          concatStepCount++;
        }
      }

      lastOutput = "vconcat";
    }

    // Handle audio processing
    if (musicIndex !== undefined && musicIndex !== -1) {
      // Trim audio to match total video duration
      filterCommands.push({
        filter: "atrim",
        options: `duration=${totalDuration}`,
        inputs: [`${musicIndex}:a`],
        outputs: ["atrimmed"],
      });

      // Reset audio timestamps
      filterCommands.push({
        filter: "asetpts",
        options: "PTS-STARTPTS",
        inputs: ["atrimmed"],
        outputs: ["apts"],
      });

      filterCommands.push({
        filter: "aformat",
        options: "sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
        inputs: ["apts"],
        outputs: ["aout"],
      });
    }

    // Add watermark if configured
    if (watermarkConfig) {
      const position = watermarkConfig.position || {
        x: "(main_w-overlay_w)/2",
        y: "main_h-overlay_h-20",
      };
      filterCommands.push({
        filter: "overlay",
        options: `${position.x}:${position.y}`,
        inputs: [lastOutput, `${watermarkIndex}:v`],
        outputs: ["vout"],
      });
    } else {
      filterCommands.push({
        filter: "null",
        inputs: [lastOutput],
        outputs: ["vout"],
      });
    }

    logger.debug("Filter graph constructed", {
      filters: filterCommands.map((f) => ({
        filter: f.filter,
        options: f.options,
      })),
      totalDuration,
    });

    return filterCommands;
  }

  private createFFmpegCommand(): ffmpeg.FfmpegCommand {
    const stderrBuffer: string[] = [];
    return (
      ffmpeg()
        .on("start", async (commandLine) => {
          const codec = await this.getAvailableCodec();
          logger.info("FFmpeg process started", {
            commandLine,
            codec,
            activeJobs: this.activeFFmpegJobs,
            globalFFmpegCount: VideoProcessingService.activeFFmpegCount,
          });

          // Increment global FFmpeg counter
          VideoProcessingService.activeFFmpegCount++;
        })
        .on("progress", (progress) =>
          this.handleFFmpegProgress(progress, "video-processing")
        )
        .on("end", () => {
          logger.info("FFmpeg process completed");
          // Decrement global FFmpeg counter
          VideoProcessingService.activeFFmpegCount = Math.max(
            0,
            VideoProcessingService.activeFFmpegCount - 1
          );
        })
        .on("error", (error: FFmpegError) => {
          // Ensure we have the full stderr output
          const fullStderr = stderrBuffer.join("\n");
          error.stderr = fullStderr || error.stderr;

          // Decrement global FFmpeg counter on error
          VideoProcessingService.activeFFmpegCount = Math.max(
            0,
            VideoProcessingService.activeFFmpegCount - 1
          );

          this.handleFFmpegError(error, "video-processing");
        })
        .on("stderr", (stderrLine) => {
          // Capture all stderr output in real-time
          stderrBuffer.push(stderrLine);

          // Log critical errors immediately
          if (
            stderrLine.includes("Error") ||
            stderrLine.includes("Invalid") ||
            stderrLine.includes("Cannot") ||
            stderrLine.includes("failed") ||
            stderrLine.includes("unable to")
          ) {
            logger.warn("FFmpeg stderr critical message", {
              line: stderrLine,
              timestamp: new Date().toISOString(),
            });
          } else {
            logger.debug("FFmpeg stderr output", {
              line: stderrLine,
              timestamp: new Date().toISOString(),
            });
          }
        })
        // Add verbose debugging output
        .outputOptions(["-v", "debug"])
    );
  }

  private handleFFmpegProgress(
    progress: FFmpegProgress,
    context: string
  ): void {
    const percent = progress.percent || 0;
    if (percent % 5 === 0 || percent === 100) {
      // Log every 5% or at completion
      logger.info(`[${context}] Processing progress`, {
        percent: `${percent.toFixed(1)}%`,
        frames: progress.frames,
        fps: progress.currentFps,
        bitrate: `${progress.currentKbps}kbps`,
        timemark: progress.timemark,
      });
    }
  }

  private handleFFmpegError(error: FFmpegError, context: string): void {
    // Extract all possible error details
    const details: Record<string, unknown> = {
      code: error.code,
      exitCode: error.exitCode,
      killed: error.killed,
      message: error.message,
      cmd: error.cmd,
    };

    // Capture full stderr if available
    if (error.stderr) {
      details.stderr = error.stderr;

      // Parse stderr for specific error patterns
      const stderrStr = error.stderr.toString();
      const errorLines = stderrStr
        .split("\n")
        .filter(
          (line) =>
            line.toLowerCase().includes("error") ||
            line.toLowerCase().includes("failed") ||
            line.toLowerCase().includes("invalid") ||
            line.toLowerCase().includes("unable to") ||
            line.toLowerCase().includes("could not") ||
            line.toLowerCase().includes("no such")
        );

      if (errorLines.length > 0) {
        details.errorLines = errorLines;
        details.lastErrorLine = errorLines[errorLines.length - 1];
      }

      // Check for common FFmpeg error patterns
      if (stderrStr.includes("Cannot allocate memory")) {
        details.errorType = "OUT_OF_MEMORY";
        details.recommendation =
          "Reduce concurrent FFmpeg processes or increase server memory";
      } else if (stderrStr.includes("Connection refused")) {
        details.errorType = "CONNECTION_REFUSED";
      } else if (
        stderrStr.includes("Invalid data found when processing input")
      ) {
        details.errorType = "CORRUPT_INPUT";
        details.recommendation =
          "Input file may be corrupted, try repairing or re-downloading";
      } else if (stderrStr.includes("Error while decoding stream")) {
        details.errorType = "DECODE_ERROR";
        details.recommendation =
          "Input file has decoding issues, try with different codec options";
      } else if (stderrStr.includes("Conversion failed!")) {
        details.errorType = "CONVERSION_FAILED";
      }
    }

    // Extract error lines from ffmpeg output
    if (error.ffmpegOutput) {
      const errorLines = error.ffmpegOutput
        .split("\n")
        .filter(
          (line) =>
            line.toLowerCase().includes("error") ||
            line.toLowerCase().includes("failed")
        );

      details.ffmpegOutput =
        errorLines.length > 0 ? errorLines : error.ffmpegOutput;
    }

    // Try to identify specific error patterns
    const errorMessage = error.message || "";
    if (errorMessage.includes("Error while opening encoder")) {
      details.errorType = "ENCODER_INITIALIZATION_FAILED";
      details.possibleCauses = [
        "Missing codec libraries",
        "Invalid encoding parameters",
        "Insufficient permissions",
        "Resource limitations",
      ];
    } else if (
      errorMessage.includes("Invalid data found when processing input")
    ) {
      details.errorType = "INVALID_INPUT_DATA";
    } else if (errorMessage.includes("No such file or directory")) {
      details.errorType = "FILE_NOT_FOUND";
    } else if (errorMessage.includes("Permission denied")) {
      details.errorType = "PERMISSION_DENIED";
    } else if (error.killed) {
      details.errorType = "PROCESS_KILLED";
      details.recommendation =
        "Check for timeout or system resource constraints";
    }

    // Log system resource information to help diagnose resource-related issues
    try {
      const memoryUsage = process.memoryUsage();
      details.systemInfo = {
        memoryUsage: {
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        },
        activeFFmpegJobs: this.activeFFmpegJobs,
        queuedJobs: this.ffmpegQueue.length,
      };
    } catch (e) {
      details.systemInfoError =
        e instanceof Error ? e.message : "Unknown error";
    }

    logger.error(`[${context}] FFmpeg processing failed`, details);

    // Create a more informative error message
    let enhancedMessage = `FFmpeg error in ${context}: ${error.message}`;
    if (details.errorType) {
      enhancedMessage += ` (Type: ${details.errorType})`;
    }
    if (error.exitCode) {
      enhancedMessage += ` (Exit code: ${error.exitCode})`;
    }
    if (details.lastErrorLine) {
      enhancedMessage += ` (Error: ${details.lastErrorLine})`;
    }

    throw new Error(enhancedMessage);
  }

  private async uploadToS3(filePath: string, s3Key: string): Promise<string> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const region = process.env.AWS_REGION || "us-east-2";
    const MAX_RETRIES = 3;

    logger.info("Starting S3 upload", { filePath, s3Key });

    // Pre-upload validation
    try {
      await fs.access(filePath, fs.constants.R_OK);
      const metadata = await this.videoValidationService.validateVideo(
        filePath
      );
      if (!metadata.hasVideo) {
        throw new Error("File has no video stream");
      }
      if (metadata.duration <= 0) {
        throw new Error(`File has invalid duration: ${metadata.duration}`);
      }
      logger.info("Pre-upload validation passed", { filePath, metadata });
    } catch (error) {
      logger.error("Pre-upload validation failed", {
        filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const fileStream = createReadStream(filePath);
        const upload = new Upload({
          client: new S3Client({
            region,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
            },
          }),
          params: {
            Bucket: bucket,
            Key: s3Key,
            Body: fileStream,
            ContentType: "video/mp4",
          },
        });

        await upload.done();
        const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;

        // Post-upload verification
        const tempVerifyPath = path.join(
          this.TEMP_DIR,
          `verify_${crypto.randomUUID()}.mp4`
        );
        try {
          await this.s3Service.downloadFile(s3Url, tempVerifyPath);
          await new Promise((r) => setTimeout(r, 500)); // Ensure file is written
          await fs.access(tempVerifyPath, fs.constants.R_OK);
          const metadata = await this.videoValidationService.validateVideo(
            tempVerifyPath
          );
          if (!metadata.hasVideo || metadata.duration <= 0) {
            throw new Error("Uploaded file is invalid or corrupted");
          }
          logger.info("Post-upload validation passed", { s3Url, metadata });
        } finally {
          if (existsSync(tempVerifyPath)) {
            await fs.unlink(tempVerifyPath).catch(() => {});
          }
        }

        logger.info("S3 upload completed and verified", {
          filePath,
          s3Key,
          s3Url,
          attempt,
        });
        return s3Url;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        logger.warn("S3 upload or verification attempt failed", {
          filePath,
          s3Key,
          attempt,
          error: lastError.message,
          stack: lastError.stack,
        });

        if (attempt === MAX_RETRIES) {
          logger.error("S3 upload failed after maximum retries", {
            filePath,
            s3Key,
            maxRetries: MAX_RETRIES,
            finalError: lastError.message,
          });
          throw lastError;
        }

        // Exponential backoff
        const backoffTime = 1000 * Math.pow(2, attempt - 1);
        logger.info(`Retrying S3 upload in ${backoffTime}ms`, {
          attempt,
          nextAttempt: attempt + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      }
    }

    // This should never be reached due to the throw in the loop, but TypeScript doesn't know that
    throw lastError || new Error("S3 upload failed after retries");
  }

  private getS3KeyFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname.slice(1);
    } catch (error) {
      logger.warn("Failed to parse S3 URL, assuming raw key", { url });
      return url;
    }
  }

  // Add this new method for lightweight validation
  private async validateVideoFile(filePath: string): Promise<boolean> {
    try {
      logger.debug(`Validating video file with FFmpeg probe: ${filePath}`);

      // Use ffprobe to check if the file is a valid video
      const result = await new Promise<{ isValid: boolean; info?: any }>(
        (resolve, reject) => {
          ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
              logger.warn(`FFprobe validation failed for ${filePath}:`, {
                error: err.message,
              });
              resolve({ isValid: false });
              return;
            }

            // Check if file has video streams
            const hasVideoStream = metadata.streams?.some(
              (stream) => stream.codec_type === "video"
            );
            if (!hasVideoStream) {
              logger.warn(`No video stream found in ${filePath}`);
              resolve({ isValid: false });
              return;
            }

            // Check if duration is available and reasonable
            const duration = metadata.format?.duration;
            if (duration === undefined || duration <= 0) {
              logger.warn(`Invalid duration (${duration}) for ${filePath}`);
              resolve({ isValid: false, info: { duration } });
              return;
            }

            // Check if file size is reasonable
            const fileSize = metadata.format?.size;
            if (fileSize === undefined || fileSize <= 0) {
              logger.warn(`Invalid file size (${fileSize}) for ${filePath}`);
              resolve({ isValid: false, info: { fileSize } });
              return;
            }

            // File passed basic validation
            logger.debug(`Video file validated successfully: ${filePath}`, {
              duration,
              size: fileSize,
              format: metadata.format?.format_name,
              videoCodec: metadata.streams?.find(
                (s) => s.codec_type === "video"
              )?.codec_name,
            });

            resolve({ isValid: true, info: metadata });
          });
        }
      );

      return result.isValid;
    } catch (error) {
      logger.error(`Error validating video file ${filePath}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  public async stitchVideos(
    inputPaths: string[],
    outputPath: string,
    options: StitchOptions = {}
  ): Promise<void> {
    // Validate input parameters
    if (!inputPaths || inputPaths.length === 0) {
      throw new Error("No input paths provided for video stitching");
    }

    if (!outputPath) {
      throw new Error("No output path provided for video stitching");
    }

    // Generate a unique job ID for tracking
    const jobId = crypto.randomUUID();
    logger.info(`[${jobId}] Starting video stitching process`, {
      inputCount: inputPaths.length,
      outputPath,
      options,
    });

    // Wait for global FFmpeg slot
    while (
      VideoProcessingService.activeFFmpegCount >=
      VideoProcessingService.MAX_GLOBAL_FFMPEG
    ) {
      logger.debug(`[${jobId}] Waiting for global FFmpeg slot`, {
        activeCount: VideoProcessingService.activeFFmpegCount,
        maxGlobal: VideoProcessingService.MAX_GLOBAL_FFMPEG,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Ensure all input files exist and are accessible
    for (const path of inputPaths) {
      try {
        await fs.access(path);
      } catch (error) {
        throw new Error(`Input file not accessible: ${path}`);
      }
    }

    // Validate each input file with lightweight probe before proceeding
    const validationResults = await Promise.all(
      inputPaths.map(async (path) => {
        const isValid = await this.validateVideoFile(path);
        return { path, isValid };
      })
    );

    const invalidFiles = validationResults.filter((result) => !result.isValid);
    if (invalidFiles.length > 0) {
      const invalidPaths = invalidFiles.map((file) => file.path).join(", ");
      throw new Error(
        `Cannot stitch videos: Invalid input files detected: ${invalidPaths}`
      );
    }

    // Enqueue the FFmpeg job
    return this.enqueueFFmpegJob(async () => {
      // Create a temporary directory for intermediate files
      const tempDir = await this.createTempDirectory();
      const tempFiles: string[] = [];

      try {
        logger.info(`[${jobId}] Starting video stitching process`, {
          inputCount: inputPaths.length,
          outputPath,
          options,
        });

        // Prepare filter complex for concatenation
        // Simplified filter graph as requested
        const inputs = inputPaths
          .map((_, i) => `[${i}:v:0][${i}:a:0]`)
          .join("");
        const filterComplex = `${inputs}concat=n=${inputPaths.length}:v=1:a=1[outv][outa]`;

        // Build the FFmpeg command
        const command = ffmpeg();

        // Add input files
        inputPaths.forEach((path) => {
          command.input(path);
        });

        // Get the best available codec
        const codec = await this.getAvailableCodec();

        // Apply filter complex
        command
          .outputOptions([
            `-filter_complex ${filterComplex}`,
            "-map [outv]",
            "-map [outa]",
          ])
          .outputOptions(`-c:v ${codec}`)
          .outputOptions("-preset fast")
          .outputOptions("-crf 22")
          .outputOptions("-c:a aac")
          .outputOptions("-b:a 128k")
          .output(outputPath);

        // Add custom output options if provided
        if (options.outputOptions) {
          options.outputOptions.forEach((opt) => {
            command.outputOptions(opt);
          });
        }

        // Execute the command with timeout
        await new Promise<void>((resolve, reject) => {
          const stderrBuffer: string[] = [];

          command
            .on("start", (commandLine) => {
              logger.info(`[${jobId}] FFmpeg started with command:`, {
                commandLine,
              });
              // Increment global FFmpeg counter
              VideoProcessingService.activeFFmpegCount++;
            })
            .on("progress", (progress) => {
              logger.debug(`[${jobId}] FFmpeg progress:`, { progress });
            })
            .on("end", () => {
              logger.info(`[${jobId}] Video stitching completed successfully`, {
                outputPath,
              });
              // Decrement global FFmpeg counter
              VideoProcessingService.activeFFmpegCount = Math.max(
                0,
                VideoProcessingService.activeFFmpegCount - 1
              );
              resolve();
            })
            .on("error", (err: FFmpegError) => {
              // Ensure we have the full stderr output
              err.stderr = stderrBuffer.join("\n") || err.stderr;

              // Decrement global FFmpeg counter on error
              VideoProcessingService.activeFFmpegCount = Math.max(
                0,
                VideoProcessingService.activeFFmpegCount - 1
              );

              this.handleFFmpegError(err, `stitchVideos-${jobId}`);
              reject(err);
            })
            .on("stderr", (stderrLine) => {
              // Capture all stderr output in real-time
              stderrBuffer.push(stderrLine);

              // Log critical errors immediately
              if (
                stderrLine.includes("Error") ||
                stderrLine.includes("Invalid") ||
                stderrLine.includes("Cannot") ||
                stderrLine.includes("failed") ||
                stderrLine.includes("unable to")
              ) {
                logger.warn(`[${jobId}] FFmpeg stderr critical message`, {
                  line: stderrLine,
                  timestamp: new Date().toISOString(),
                });
              }
            })
            .run();

          // Set a timeout to kill the process if it runs too long
          const timeoutId = setTimeout(() => {
            logger.error(
              `[${jobId}] FFmpeg process timed out after ${this.FFmpeg_TIMEOUT}ms`
            );
            command.kill("SIGKILL");
            reject(
              new Error(
                `FFmpeg process timed out after ${this.FFmpeg_TIMEOUT}ms`
              )
            );
          }, this.FFmpeg_TIMEOUT);

          // Clear the timeout when the process ends
          command.on("end", () => clearTimeout(timeoutId));
          command.on("error", () => clearTimeout(timeoutId));
        });
      } catch (error) {
        // Re-throw the error after cleanup
        throw error;
      } finally {
        // Clean up temporary files
        try {
          for (const file of tempFiles) {
            await fs.unlink(file).catch((err) => {
              logger.warn(`Failed to delete temporary file ${file}:`, {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }

          // Remove temporary directory
          await fs.rmdir(tempDir).catch((err) => {
            logger.warn(`Failed to delete temporary directory ${tempDir}:`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });

          logger.debug(`[${jobId}] Temporary files cleanup completed`);
        } catch (cleanupError) {
          logger.warn(
            `[${jobId}] Error during cleanup after video stitching:`,
            {
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            }
          );
        }
      }
    });
  }

  private async getAvailableCodec(): Promise<string> {
    // Cache the result to avoid repeated checks
    if (this._cachedCodec) {
      return this._cachedCodec;
    }

    return new Promise<string>((resolve) => {
      logger.debug("Checking available video codecs");

      exec("ffmpeg -encoders", (error, stdout) => {
        if (error) {
          logger.warn(
            "Failed to check FFmpeg encoders, defaulting to libx264",
            {
              error: error instanceof Error ? error.message : String(error),
            }
          );
          this._cachedCodec = "libx264";
          resolve("libx264");
          return;
        }

        // Check for hardware acceleration options
        const hasNvenc = stdout.includes("h264_nvenc");
        const hasQsv = stdout.includes("h264_qsv");
        const hasVideotoolbox = stdout.includes("h264_videotoolbox");
        const hasVaapi = stdout.includes("h264_vaapi");
        const hasLibx264 = stdout.includes("libx264");

        logger.info("Available FFmpeg encoders detected", {
          hasLibx264,
          hasNvenc,
          hasQsv,
          hasVideotoolbox,
          hasVaapi,
        });

        // Store reference to this for use in callbacks
        const self = this;

        // Try hardware encoders first
        if (hasNvenc) {
          // Test NVENC with a simple command
          exec(
            "ffmpeg -f lavfi -i color=c=black:s=32x32:r=1 -t 1 -c:v h264_nvenc -f null -",
            (nvencError) => {
              if (!nvencError) {
                logger.info("Using NVIDIA hardware acceleration (h264_nvenc)");
                self._cachedCodec = "h264_nvenc";
                resolve("h264_nvenc");
              } else {
                logger.warn(
                  "NVENC detected but not working, trying next option",
                  {
                    error:
                      nvencError instanceof Error
                        ? nvencError.message
                        : String(nvencError),
                  }
                );
                tryNextCodec();
              }
            }
          );
        } else {
          tryNextCodec();
        }

        function tryNextCodec() {
          if (hasQsv) {
            // Test Intel QuickSync
            exec(
              "ffmpeg -f lavfi -i color=c=black:s=32x32:r=1 -t 1 -c:v h264_qsv -f null -",
              (qsvError) => {
                if (!qsvError) {
                  logger.info(
                    "Using Intel QuickSync hardware acceleration (h264_qsv)"
                  );
                  self._cachedCodec = "h264_qsv";
                  resolve("h264_qsv");
                } else {
                  logger.warn(
                    "QSV detected but not working, trying next option",
                    {
                      error:
                        qsvError instanceof Error
                          ? qsvError.message
                          : String(qsvError),
                    }
                  );
                  tryVideotoolbox();
                }
              }
            );
          } else {
            tryVideotoolbox();
          }
        }

        function tryVideotoolbox() {
          if (hasVideotoolbox) {
            // Test Apple VideoToolbox
            exec(
              "ffmpeg -f lavfi -i color=c=black:s=32x32:r=1 -t 1 -c:v h264_videotoolbox -f null -",
              (vtError) => {
                if (!vtError) {
                  logger.info(
                    "Using Apple VideoToolbox hardware acceleration (h264_videotoolbox)"
                  );
                  self._cachedCodec = "h264_videotoolbox";
                  resolve("h264_videotoolbox");
                } else {
                  logger.warn(
                    "VideoToolbox detected but not working, trying next option",
                    {
                      error:
                        vtError instanceof Error
                          ? vtError.message
                          : String(vtError),
                    }
                  );
                  tryVaapi();
                }
              }
            );
          } else {
            tryVaapi();
          }
        }

        function tryVaapi() {
          if (hasVaapi) {
            // Test VAAPI
            exec(
              "ffmpeg -f lavfi -i color=c=black:s=32x32:r=1 -t 1 -c:v h264_vaapi -f null -",
              (vaapiError) => {
                if (!vaapiError) {
                  logger.info("Using VAAPI hardware acceleration (h264_vaapi)");
                  self._cachedCodec = "h264_vaapi";
                  resolve("h264_vaapi");
                } else {
                  logger.warn(
                    "VAAPI detected but not working, falling back to libx264",
                    {
                      error:
                        vaapiError instanceof Error
                          ? vaapiError.message
                          : String(vaapiError),
                    }
                  );
                  fallbackToLibx264();
                }
              }
            );
          } else {
            fallbackToLibx264();
          }
        }

        function fallbackToLibx264() {
          // Fallback to software encoding
          logger.info("Using software encoding (libx264)");
          self._cachedCodec = "libx264";
          resolve("libx264");
        }
      });
    });
  }

  public async batchProcessVideos(
    inputVideos: string[],
    outputPath: string,
    options: VideoProcessingOptions = {}
  ): Promise<void> {
    const startTime = Date.now();
    logger.info("Starting batch video processing", {
      videoCount: inputVideos.length,
      outputPath,
      hasMusic: !!options.music,
      reverse: options.reverse,
    });

    const tempDir = path.join(this.TEMP_DIR, `batch_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const batchSize = 3;
      const batches = [];
      for (let i = 0; i < inputVideos.length; i += batchSize) {
        batches.push(inputVideos.slice(i, i + batchSize));
      }

      for (const [index, batch] of batches.entries()) {
        logger.info(`Processing batch ${index + 1}/${batches.length}`, {
          videoCount: batch.length,
        });
        const batchOutputs = await Promise.all(
          batch.map(async (video, idx) => {
            const outputFile = path.join(tempDir, `processed_${idx}.mp4`);
            const clips = [{ path: video, duration: 5 }];

            // Create a simple template
            const template: VideoTemplate = {
              name: "batch_item",
              music: options.music,
            };

            // Use stitchVideoClips instead of stitchVideos
            await this.stitchVideoClips(clips, outputFile, template);

            return outputFile;
          })
        );
        logger.info(`Batch ${index + 1} completed`, { outputs: batchOutputs });
      }

      const processedFiles = await fs.readdir(tempDir);
      const processedPaths = processedFiles
        .filter((file) => file.startsWith("processed_"))
        .map((file) => path.join(tempDir, file))
        .sort(
          (a, b) =>
            parseInt(a.match(/processed_(\d+)\.mp4/)?.[1] || "0") -
            parseInt(b.match(/processed_(\d+)\.mp4/)?.[1] || "0")
        );

      const finalClips = processedPaths.map((path) => ({ path, duration: 5 }));

      // Create a simple template for the final output
      const finalTemplate: VideoTemplate = {
        name: "batch_final",
        music: options.music,
      };

      // Use stitchVideoClips instead of stitchVideos
      await this.stitchVideoClips(finalClips, outputPath, finalTemplate);

      logger.info("Batch processing completed", {
        outputPath,
        durationMs: Date.now() - startTime,
        totalVideos: inputVideos.length,
      });
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        logger.info("Cleaned up temporary batch directory", { tempDir });
      } catch (error) {
        logger.warn("Failed to clean up temporary batch directory", {
          tempDir,
          error,
        });
      }
    }
  }

  async createVideoFromClips(
    clips: VideoClip[],
    outputPath: string,
    template?: ReelTemplate
  ): Promise<void> {
    // Extract paths from clips
    const inputPaths = clips.map((clip) => clip.path);

    // Create a VideoTemplate from ReelTemplate
    const videoTemplate: VideoTemplate = {
      name: template?.name || "default",
      music: template?.music,
      // No outputOptions in ReelTemplate
    };

    // Call the stitchVideos method with proper types
    await this.stitchVideos(inputPaths, outputPath, {});
  }

  public async processClips(
    clips: VideoClip[],
    outputPath: string,
    template?: ReelTemplate
  ): Promise<void> {
    // Extract paths from clips
    const inputPaths = clips.map((clip) => clip.path);

    // Create options for stitchVideos
    // Note: ReelTemplate doesn't have outputOptions property
    const options: StitchOptions = {};

    // Call the stitchVideos method with proper types
    await this.stitchVideos(inputPaths, outputPath, options);
  }

  async extractFrame(
    inputPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<void> {
    logger.info("Extracting frame", { inputPath, outputPath, timestamp });
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: [timestamp],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
        })
        .on("end", () => {
          logger.info("Frame extraction completed", { outputPath });
          resolve();
        })
        .on("error", (error) => {
          logger.error("Frame extraction failed", { error: error.message });
          reject(error);
        });
    });
  }

  public async getVideoDuration(filePath: string): Promise<number> {
    try {
      const metadata = await this.videoValidationService.validateVideo(
        filePath
      );
      return metadata.duration;
    } catch (error) {
      logger.error("Failed to get video duration", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  public async validateVideoIntegrity(filePath: string): Promise<boolean> {
    try {
      const metadata = await this.videoValidationService.validateVideo(
        filePath
      );
      return metadata.hasVideo && metadata.duration > 0;
    } catch (error) {
      logger.error("Video integrity check failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        filePath,
      });
      return false;
    }
  }

  /**
   * Get video metadata including dimensions, codec info, and stream details
   */
  public async getVideoMetadata(filePath: string): Promise<{
    hasVideo: boolean;
    hasAudio?: boolean;
    width?: number;
    height?: number;
    duration?: number;
    codec?: string;
    fps?: number;
  }> {
    try {
      const metadata = await this.videoValidationService.validateVideo(
        filePath
      );
      return {
        hasVideo: metadata.hasVideo,
        hasAudio: metadata.hasAudio,
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        codec: metadata.codec,
        fps: metadata.fps,
      };
    } catch (error) {
      logger.error("Failed to get video metadata", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  public async validateMusicFile(filePath: string): Promise<boolean> {
    try {
      // First check if file exists and has content
      await this.validateFile(filePath, "music");

      // Try to get duration as additional validation
      const duration = await this.getVideoDuration(filePath);

      if (duration <= 0) {
        logger.warn("Invalid music file duration", {
          path: filePath,
          duration,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.warn("Music file validation failed", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  // Process the FFmpeg job queue
  private async processFFmpegQueue() {
    if (this.processingLock) return;

    this.processingLock = true;
    try {
      while (
        this.ffmpegQueue.length > 0 &&
        this.activeFFmpegJobs < this.MAX_CONCURRENT_JOBS
      ) {
        const job = this.ffmpegQueue.shift();
        if (job) {
          this.activeFFmpegJobs++;
          try {
            await job();
          } catch (error) {
            logger.error("FFmpeg job failed in queue processor", {
              error: error instanceof Error ? error.message : "Unknown error",
              activeJobs: this.activeFFmpegJobs,
              queueLength: this.ffmpegQueue.length,
            });
          } finally {
            this.activeFFmpegJobs--;
          }
        }
      }
    } finally {
      this.processingLock = false;

      // If there are still jobs and we're not at capacity, continue processing
      if (
        this.ffmpegQueue.length > 0 &&
        this.activeFFmpegJobs < this.MAX_CONCURRENT_JOBS
      ) {
        setTimeout(() => this.processFFmpegQueue(), 100);
      }
    }
  }

  // Add a job to the queue and start processing if possible
  private enqueueFFmpegJob(job: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const wrappedJob = async () => {
        try {
          await job();
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      this.ffmpegQueue.push(wrappedJob);
      logger.info("Added FFmpeg job to queue", {
        queueLength: this.ffmpegQueue.length,
        activeJobs: this.activeFFmpegJobs,
      });

      // Trigger queue processing
      if (
        !this.processingLock &&
        this.activeFFmpegJobs < this.MAX_CONCURRENT_JOBS
      ) {
        setTimeout(() => this.processFFmpegQueue(), 0);
      }
    });
  }

  private async createTempDirectory(): Promise<string> {
    const tempDir = path.join(this.TEMP_DIR, `temp_${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    logger.debug(`Created temporary directory: ${tempDir}`);
    return tempDir;
  }

  // Update the stitchVideoClips method to handle video-only clips and add music as requested
  public async stitchVideoClips(
    clips: VideoClip[],
    outputPath: string,
    template: VideoTemplate,
    watermarkConfig?: WatermarkConfig,
    progressEmitter?: EventEmitter
  ): Promise<void> {
    const jobId = crypto.randomUUID();
    logger.info(`[${jobId}] Starting stitchVideoClips`, {
      clipCount: clips.length,
      templateName: template.name,
      outputPath,
      hasMusic: !!template.music,
      hasWatermark: !!watermarkConfig,
    });

    try {
      // Validate and resolve clip paths
      const validatedClips = await Promise.all(
        clips.map(async (clip, index) => {
          if (!clip.path) {
            throw new Error(`Clip ${index} has no path`);
          }

          const resolvedPath =
            clip.path.startsWith("http") || clip.path.startsWith("s3://")
              ? await this.resolveAssetPath(clip.path, "video", true)
              : clip.path;

          const metadata = await this.getVideoMetadata(resolvedPath);
          if (!metadata.hasVideo || !metadata.duration) {
            throw new Error(
              `Clip ${index} is invalid: no video or zero duration`
            );
          }
          clip.duration = clip.duration || metadata.duration;

          logger.info(`[${jobId}] Validated clip ${index}`, {
            path: resolvedPath,
            duration: clip.duration,
            hasAudio: metadata.hasAudio,
          });
          return { ...clip, path: resolvedPath, hasAudio: metadata.hasAudio };
        })
      );

      // Resolve music if present
      let musicPath: string | undefined;
      if (template.music?.path) {
        try {
          musicPath = await this.resolveAssetPath(
            template.music.path,
            "music",
            false
          );
          if (musicPath) {
            const musicMetadata = await this.getVideoMetadata(musicPath);
            if (!musicMetadata.hasAudio) {
              logger.warn(`[${jobId}] Music file has no audio, ignoring`, {
                path: musicPath,
              });
              musicPath = undefined;
            } else {
              logger.info(`[${jobId}] Validated music`, {
                path: musicPath,
                duration: musicMetadata.duration,
              });
            }
          }
        } catch (error) {
          logger.warn(
            `[${jobId}] Failed to resolve music, continuing without`,
            {
              musicPath: template.music.path,
              error: error instanceof Error ? error.message : String(error),
            }
          );
          musicPath = undefined;
        }
      }

      // Resolve watermark if present
      let watermarkPath: string | undefined;
      if (watermarkConfig?.path) {
        try {
          watermarkPath = await this.resolveAssetPath(
            watermarkConfig.path,
            "watermark",
            false
          );
          if (!watermarkPath) {
            logger.warn(
              `[${jobId}] Failed to resolve watermark, continuing without`,
              {
                path: watermarkConfig.path,
              }
            );
          }
        } catch (error) {
          logger.warn(
            `[${jobId}] Failed to resolve watermark, continuing without`,
            {
              path: watermarkConfig.path,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }

      // Calculate total duration for audio trimming
      const totalDuration = validatedClips.reduce(
        (sum, clip) => sum + clip.duration,
        0
      );

      // Build FFmpeg command
      const command = ffmpeg();

      // Add video inputs
      validatedClips.forEach((clip) => {
        command.input(clip.path);
      });

      // Add music input if present
      const musicIndex = musicPath ? validatedClips.length : -1;
      if (musicPath) {
        command.input(musicPath);
      }

      // Add watermark input if present
      const watermarkIndex = watermarkPath
        ? musicIndex !== -1
          ? musicIndex + 1
          : validatedClips.length
        : -1;
      if (watermarkPath) {
        command.input(watermarkPath);
      }

      // Build filter graph
      const filterCommands: ffmpeg.FilterSpecification[] = [];

      // Process each video clip
      validatedClips.forEach((clip, i) => {
        // Trim to exact duration
        filterCommands.push({
          filter: "trim",
          options: `duration=${clip.duration}`,
          inputs: [`${i}:v`],
          outputs: [`v${i}`],
        });

        // Reset timestamps
        filterCommands.push({
          filter: "setpts",
          options: "PTS-STARTPTS",
          inputs: [`v${i}`],
          outputs: [`pts${i}`],
        });

        // Apply color correction if specified
        if (clip.colorCorrection?.ffmpegFilter) {
          filterCommands.push({
            filter: "eq",
            options: clip.colorCorrection.ffmpegFilter,
            inputs: [`pts${i}`],
            outputs: [`color${i}`],
          });
        } else {
          filterCommands.push({
            filter: "null",
            inputs: [`pts${i}`],
            outputs: [`color${i}`],
          });
        }
      });

      // Concatenate video streams
      const concatInputs = validatedClips.map((_, i) => `color${i}`);
      filterCommands.push({
        filter: "concat",
        options: `n=${validatedClips.length}:v=1:a=0`,
        inputs: concatInputs,
        outputs: ["vconcat"],
      });

      // Process music if present
      if (musicIndex !== -1) {
        // Trim audio to match total video duration
        filterCommands.push({
          filter: "atrim",
          options: `duration=${totalDuration}`,
          inputs: [`${musicIndex}:a`],
          outputs: ["atrimmed"],
        });

        // Reset audio timestamps
        filterCommands.push({
          filter: "asetpts",
          options: "PTS-STARTPTS",
          inputs: ["atrimmed"],
          outputs: ["apts"],
        });

        // Format audio
        filterCommands.push({
          filter: "aformat",
          options: "sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
          inputs: ["apts"],
          outputs: ["aout"],
        });
      }

      // Add watermark if present
      let finalVideoOutput = "vconcat";
      if (watermarkIndex !== -1) {
        const position = watermarkConfig?.position || {
          x: "(main_w-overlay_w)/2",
          y: "main_h-overlay_h-20",
        };

        filterCommands.push({
          filter: "overlay",
          options: `${position.x}:${position.y}`,
          inputs: ["vconcat", `${watermarkIndex}:v`],
          outputs: ["vout"],
        });

        finalVideoOutput = "vout";
      }

      // Apply filter graph
      command.complexFilter(filterCommands);

      // Map outputs
      command.outputOptions(["-map", `[${finalVideoOutput}]`]);
      if (musicIndex !== -1) {
        command.outputOptions(["-map", "[aout]"]);
      }

      // Set codec options
      command.outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "22",
      ]);
      if (musicIndex !== -1) {
        command.outputOptions(["-c:a", "aac", "-b:a", "128k"]);
      }

      // Add template output options if any
      if (template.outputOptions) {
        template.outputOptions.forEach((opt) => {
          command.outputOptions(opt);
        });
      }

      // Set output
      command.output(outputPath);

      // Execute FFmpeg
      await new Promise<void>((resolve, reject) => {
        const stderrBuffer: string[] = [];

        command
          .on("start", (commandLine) => {
            logger.info(`[${jobId}] FFmpeg started`, { commandLine });
          })
          .on("progress", (progress) => {
            if (progress.percent !== undefined) {
              logger.debug(
                `[${jobId}] FFmpeg progress: ${progress.percent.toFixed(1)}%`
              );
              progressEmitter?.emit("progress", progress);
            }
          })
          .on("end", () => {
            logger.info(`[${jobId}] Video stitching completed`, { outputPath });
            resolve();
          })
          .on("error", (err: FFmpegError) => {
            // Ensure we have the full stderr output
            err.stderr = stderrBuffer.join("\n") || err.stderr;

            logger.error(`[${jobId}] FFmpeg error in stitchVideoClips`, {
              error: err.message,
              stderr: err.stderr,
              code: err.code,
              exitCode: err.exitCode,
            });
            reject(err);
          })
          .on("stderr", (stderrLine) => {
            // Capture all stderr output in real-time
            stderrBuffer.push(stderrLine);

            // Log critical errors immediately
            if (
              stderrLine.includes("Error") ||
              stderrLine.includes("Invalid") ||
              stderrLine.includes("Cannot") ||
              stderrLine.includes("failed") ||
              stderrLine.includes("unable to")
            ) {
              logger.warn(`[${jobId}] FFmpeg stderr critical message`, {
                line: stderrLine,
                timestamp: new Date().toISOString(),
              });
            }
          })
          .run();
      });

      // Verify the output file exists and is valid
      await this.validateFile(outputPath, "Output video");
      logger.info(`[${jobId}] Successfully created video`, { outputPath });
    } catch (error) {
      logger.error(`[${jobId}] stitchVideoClips failed`, {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error; // Propagate to caller
    }
  }

  public async createSlideshowFromImages(
    images: string[],
    outputPath: string,
    options: SlideshowOptions = {}
  ): Promise<void> {
    if (!images || images.length === 0) {
      throw new Error("No images provided for slideshow");
    }

    if (!outputPath) {
      throw new Error("No output path provided for slideshow");
    }

    const outputFile = outputPath;

    try {
      // Convert image paths to video clips
      const imageClips: VideoClip[] = images.map((imagePath) => ({
        path: imagePath,
        duration: options.slideDuration || 3,
      }));

      // Create a simple template
      const template: VideoTemplate = {
        name: "slideshow",
        outputOptions: options.outputOptions,
      };

      // Use stitchVideoClips instead of stitchVideos
      await this.stitchVideoClips(imageClips, outputFile, template);

      logger.info("Slideshow created successfully", { outputPath });
    } catch (error) {
      logger.error("Failed to create slideshow", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async createTimelapseFromImages(
    images: string[],
    outputPath: string,
    options: TimelapseOptions = {}
  ): Promise<void> {
    if (!images || images.length === 0) {
      throw new Error("No images provided for timelapse");
    }

    if (!outputPath) {
      throw new Error("No output path provided for timelapse");
    }

    const fps = options.fps || 24;

    try {
      // Convert image paths to video clips
      const imageClips: VideoClip[] = images.map((imagePath: string) => ({
        path: imagePath,
        duration: 1 / fps, // Duration of each frame
      }));

      // Create a simple template
      const template: VideoTemplate = {
        name: "timelapse",
        outputOptions: options.outputOptions,
      };

      // Use stitchVideoClips instead of stitchVideos
      await this.stitchVideoClips(imageClips, outputPath, template);

      logger.info("Timelapse created successfully", {
        outputPath,
        frameCount: images.length,
      });
    } catch (error) {
      logger.error("Failed to create timelapse", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async createGifFromImages(
    images: string[],
    outputPath: string,
    options: GifOptions = {}
  ): Promise<void> {
    if (!images || images.length === 0) {
      throw new Error("No images provided for GIF");
    }

    if (!outputPath) {
      throw new Error("No output path provided for GIF");
    }

    try {
      // Convert image paths to video clips
      const imageClips: VideoClip[] = images.map((imagePath: string) => ({
        path: imagePath,
        duration: options.frameDuration || 0.1,
      }));

      // Create a simple template
      const template: VideoTemplate = {
        name: "gif",
        outputOptions: ["-f gif"],
      };

      // Extract paths from clips for the stitchVideos method
      const inputPaths = imageClips.map((clip) => clip.path);

      // Create options for the stitchVideos method
      const stitchOptions: StitchOptions = {
        outputOptions: template.outputOptions,
      };

      // Use stitchVideos with extracted paths
      await this.stitchVideos(inputPaths, outputPath, stitchOptions);

      logger.info("GIF created successfully", {
        outputPath,
        frameCount: images.length,
      });
    } catch (error) {
      logger.error("Failed to create GIF", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Update the createVideo method to use stitchVideoClips instead of stitchVideos
  public async createVideo(
    clips: VideoClip[],
    outputPath: string,
    template: VideoTemplate,
    watermarkConfig?: WatermarkConfig,
    progressEmitter?: EventEmitter
  ): Promise<void> {
    const startTime = Date.now();
    const jobId = crypto.randomUUID();
    const tempFiles: string[] = []; // Track files for cleanup

    logger.info(`[${jobId}] Starting video creation with enhanced validation`, {
      clipCount: clips.length,
      outputPath,
      templateName: template.name,
      hasWatermark: !!watermarkConfig,
      hasMusic: !!template.music?.path,
    });

    const localOutput = outputPath.startsWith("https://")
      ? path.join(this.TEMP_DIR, `temp_output_${crypto.randomUUID()}.mp4`)
      : outputPath;
    tempFiles.push(localOutput);

    try {
      // Use the stitchVideoClips method for processing
      await this.stitchVideoClips(
        clips,
        localOutput,
        template,
        watermarkConfig,
        progressEmitter
      );

      // Handle S3 upload if needed
      if (outputPath.startsWith("https://")) {
        const s3Key = this.getS3KeyFromUrl(outputPath);
        await this.uploadToS3(localOutput, s3Key);
      }

      logger.info(`[${jobId}] Video creation completed successfully`, {
        outputPath,
        durationMs: Date.now() - startTime,
        clipCount: clips.length,
      });
    } catch (error) {
      logger.error(`[${jobId}] Video creation failed`, {
        outputPath,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - startTime,
      });
      throw error;
    } finally {
      // Clean up temporary files
      for (const file of tempFiles) {
        if (file !== outputPath && existsSync(file)) {
          await fs.unlink(file).catch((err) => {
            logger.warn(
              `[${jobId}] Failed to clean up temporary file: ${file}`,
              {
                error: err instanceof Error ? err.message : String(err),
              }
            );
          });
        }
      }
    }
  }
}

export const videoProcessingService = VideoProcessingService.getInstance();
