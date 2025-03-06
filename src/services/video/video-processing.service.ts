import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import { existsSync, mkdirSync, statSync } from "fs";
import { createReadStream } from "fs";
import * as path from "path";
import * as crypto from "crypto";
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
import { resourceManager } from "../video/resource-manager.service.js";
import { ffmpegQueueManager } from "../ffmpegQueueManager.js";
import { reelTemplates } from "../imageProcessing/templates/types.js";
import os from "os";

const TARGET_FRAME_RATE = 24;

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
  hasAudio?: boolean;
  isMapVideo?: boolean;
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

  private readonly TEMP_DIR = process.env.TEMP_OUTPUT_DIR || "./temp";
  private s3Service: S3Service;
  private s3VideoService: S3VideoService;
  private videoValidationService: VideoValidationService;
  private readonly FFmpeg_TIMEOUT = 60 * 60 * 1000; // 1 hour timeout
  private segmentCache: Map<string, string> = new Map(); // Cache for downloaded segments

  // Add a private property to cache the codec
  private _cachedCodec: string | null = null;

  // Add this property to the class
  private _lastLoggedPercent: number | null = null;

  // Add this property to the class
  private _lastEmittedPercent: number | null = null;

  private constructor() {
    this.s3Service = new S3Service();
    this.s3VideoService = S3VideoService.getInstance();
    this.videoValidationService = VideoValidationService.getInstance();
    if (!existsSync(this.TEMP_DIR)) {
      mkdirSync(this.TEMP_DIR, { recursive: true });
      logger.info("Created TEMP_DIR", { path: this.TEMP_DIR });
    }

    // Set up periodic cache cleanup (every 30 minutes)
    setInterval(() => this.cleanupSegmentCache(), 30 * 60 * 1000);

    // Add uncaught exception handler for cleanup
    process.on("uncaughtException", async (error) => {
      logger.error(
        "Uncaught exception in VideoProcessingService, cleaning up resources",
        {
          error: error instanceof Error ? error.message : String(error),
          activeJobs: ffmpegQueueManager.getActiveCount(),
        }
      );

      // Clear segment cache
      this.cleanupSegmentCache(true);

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
    const tempValidationPath = `${filePath}_${crypto.randomUUID()}_validate.mp4`; // Unique temp path
    try {
      // Copy file to avoid race condition with cleanup
      await fs.copyFile(filePath, tempValidationPath);

      // Attempt repair only if initial validation fails
      let metadata = await this.videoValidationService.validateVideo(
        tempValidationPath
      );
      let finalPath = tempValidationPath;
      if (
        (!metadata.hasVideo && context !== "music") ||
        metadata.duration <= 0
      ) {
        const repairedPath = await this.repairVideo(
          tempValidationPath,
          context
        );
        if (repairedPath) {
          finalPath = repairedPath;
          metadata = await this.videoValidationService.validateVideo(finalPath);
        }
      }

      // For music files, we only need to check if it has audio and valid duration
      if (context === "music") {
        if (!metadata.hasAudio) {
          throw new Error(`${context} has no audio stream`);
        }
      } else {
        // For video files, we need to check if it has video
        if (!metadata.hasVideo) {
          throw new Error(`${context} has no video stream`);
        }
      }

      if (metadata.duration <= 0) {
        throw new Error(
          `${context} has invalid duration: ${metadata.duration}`
        );
      }
      logger.info("Video validation result", { path: finalPath, ...metadata });
    } catch (error) {
      logger.error(`Validation failed for ${context}`, {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      // Cleanup temp file
      if (existsSync(tempValidationPath)) {
        await fs.unlink(tempValidationPath).catch((err) =>
          logger.warn(`Failed to cleanup temp validation file`, {
            path: tempValidationPath,
            error: err.message,
          })
        );
      }
    }
  }

  private async repairVideo(
    filePath: string,
    context: string
  ): Promise<string | null> {
    const extension = context === "music" ? ".mp3" : ".mp4";
    const repairedPath = `${
      this.TEMP_DIR
    }/repaired_${crypto.randomUUID()}${extension}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const command = ffmpeg(filePath);

        if (context === "music") {
          // For music files, focus on audio
          command.outputOptions([
            "-c:a",
            "copy",
            "-vn", // No video
          ]);
        } else {
          // For video files, copy both streams
          command.outputOptions([
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-map",
            "0",
            "-f",
            "mp4",
          ]);
        }

        command
          .output(repairedPath)
          .on("end", () => resolve())
          .on("error", (err) =>
            reject(new Error(`Repair failed for ${context}: ${err.message}`))
          )
          .run();
      });
      logger.info(`Repaired potentially corrupted ${context}`, {
        original: filePath,
        repaired: repairedPath,
      });
      return repairedPath;
    } catch (error) {
      logger.warn(`Repair attempt failed for ${context}`, {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      if (existsSync(repairedPath))
        await fs.unlink(repairedPath).catch(() => {});
      return null;
    }
  }

  private async resolveAssetPath(
    assetPath: string,
    type: "music" | "watermark" | "video",
    isRequired: boolean = false
  ): Promise<string> {
    logger.debug(`Resolving ${type} asset path`, { assetPath });

    // Handle S3/HTTPS URLs and paths that start with "assets/" (S3 relative paths)
    if (
      assetPath.startsWith("https://") ||
      assetPath.startsWith("s3://") ||
      assetPath.startsWith("assets/")
    ) {
      // Convert relative S3 paths to full S3 URLs
      const normalizedPath = assetPath.startsWith("s3://")
        ? assetPath.replace("s3://", "https://")
        : assetPath.startsWith("assets/")
        ? `https://${process.env.AWS_BUCKET || "reelty-prod-storage"}.s3.${
            process.env.AWS_REGION || "us-east-2"
          }.amazonaws.com/${assetPath}`
        : assetPath;

      // Check if we already have this asset cached
      const cachedPath = this.segmentCache.get(normalizedPath);
      if (cachedPath && existsSync(cachedPath)) {
        logger.debug(`Using cached ${type} asset`, {
          assetPath: normalizedPath,
          cachedPath,
        });
        return cachedPath;
      }

      // Not in cache, need to download
      const cacheKey = crypto
        .createHash("md5")
        .update(normalizedPath)
        .digest("hex");
      const localPath = path.join(
        this.TEMP_DIR,
        `temp_${cacheKey}_${path.basename(assetPath)}`
      );
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.s3Service.downloadFile(normalizedPath, localPath);
          await new Promise((r) => setTimeout(r, 500)); // Ensure file is written
          await fs.access(localPath, fs.constants.R_OK);

          // Use appropriate validation based on asset type
          if (type === "music") {
            const isValid = await this.validateMusicFile(localPath);
            if (!isValid) {
              throw new Error(
                `Invalid ${type} file: no audio stream or zero duration`
              );
            }
          } else {
            const metadata = await this.videoValidationService.validateVideo(
              localPath
            );
            if (
              type === "video" &&
              (!metadata.hasVideo || metadata.duration <= 0)
            ) {
              throw new Error(
                `Invalid ${type} file: no video stream or zero duration`
              );
            }
          }

          // Add to cache
          this.segmentCache.set(normalizedPath, localPath);

          logger.info(
            `Downloaded, validated, and cached ${type} asset from S3`,
            {
              assetPath: normalizedPath,
              localPath,
              attempt,
            }
          );
          return localPath; // Cleanup deferred to stitchVideos
        } catch (error) {
          logger.warn(
            `Failed to download/validate ${type} asset, attempt ${attempt}/${maxRetries}`,
            {
              assetPath: normalizedPath,
              localPath,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
          if (attempt === maxRetries) {
            throw new Error(
              `Failed to resolve ${type} asset after ${maxRetries} attempts: ${normalizedPath}`
            );
          }
          await fs.unlink(localPath).catch(() => {});
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    // Handle local files
    try {
      await fs.access(assetPath, fs.constants.R_OK);

      // Use appropriate validation based on asset type
      if (type === "music") {
        const isValid = await this.validateMusicFile(assetPath);
        if (!isValid) {
          throw new Error(
            `Invalid local ${type} file: no audio stream or zero duration`
          );
        }
      } else {
        const metadata = await this.videoValidationService.validateVideo(
          assetPath
        );
        if (
          type === "video" &&
          (!metadata.hasVideo || metadata.duration <= 0)
        ) {
          throw new Error(
            `Invalid local ${type} file: no video stream or zero duration`
          );
        }
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

  // Helper method to copy a file to a temporary location if needed
  private async copyToTempIfNeeded(
    sourcePath: string,
    needsCopy: boolean
  ): Promise<string> {
    if (!needsCopy) return sourcePath;

    const tempPath = path.join(
      this.TEMP_DIR,
      `temp_copy_${crypto.randomUUID()}_${path.basename(sourcePath)}`
    );

    await fs.copyFile(sourcePath, tempPath);
    logger.debug("Copied file to temporary location", {
      source: sourcePath,
      temp: tempPath,
    });

    return tempPath;
  }

  private buildFilterGraph(
    clips: VideoClip[],
    watermarkConfig?: WatermarkConfig,
    musicIndex?: number,
    watermarkIndex?: number
  ): ffmpeg.FilterSpecification[] | null {
    if (!clips.length) return null;

    const filterCommands: ffmpeg.FilterSpecification[] = [];
    let lastOutput = "";

    // Check if we're processing a complex template like googlezoomintro
    const isComplexTemplate = clips.some((clip) => clip.isMapVideo);

    // For complex templates, use a more optimized filter graph
    if (isComplexTemplate) {
      logger.info(
        `Using optimized filter graph for complex template with ${clips.length} clips`
      );

      // Process each clip with minimal operations
      clips.forEach((clip, i) => {
        // Simple trim operation
        filterCommands.push({
          filter: "trim",
          options: `duration=${clip.duration}`,
          inputs: [`${i}:v`],
          outputs: [`v${i}`],
        });

        // Set PTS
        filterCommands.push({
          filter: "setpts",
          options: "PTS-STARTPTS",
          inputs: [`v${i}`],
          outputs: [`pts${i}`],
        });

        // Apply minimal color correction based on clip type
        // Map videos get no color correction to preserve quality
        const colorOptions = clip.isMapVideo
          ? "contrast=1.0:brightness=0.0:saturation=1.0" // Neutral for map videos
          : "contrast=1.05:brightness=0.02:saturation=1.1"; // Minimal for regular clips

        filterCommands.push({
          filter: "eq",
          options: colorOptions,
          inputs: [`pts${i}`],
          outputs: [`color${i}`],
        });
      });

      // Simple concatenation
      const concatInputs = clips.map((_, i) => `color${i}`);
      filterCommands.push({
        filter: "concat",
        options: `n=${clips.length}:v=1:a=0`,
        inputs: concatInputs,
        outputs: ["vconcat"],
      });

      lastOutput = "vconcat";
    } else {
      // Original more complex filter graph for non-complex templates
      clips.forEach((clip, i) => {
        const baseInput = `${i}:v`;
        let currentOutput = "";

        // Trim
        filterCommands.push({
          filter: "trim",
          options: `duration=${clip.duration}`,
          inputs: [baseInput],
          outputs: [`v${i}`],
        });

        // Set PTS
        filterCommands.push({
          filter: "setpts",
          options: "PTS-STARTPTS",
          inputs: [`v${i}`],
          outputs: [`pts${i}`],
        });

        // Apply color correction if specified
        currentOutput = `color${i}`;
        if (clip.colorCorrection?.ffmpegFilter) {
          filterCommands.push({
            filter: "eq",
            options: clip.colorCorrection.ffmpegFilter,
            inputs: [`pts${i}`],
            outputs: [currentOutput],
          });
        } else {
          // Default color correction
          filterCommands.push({
            filter: "eq",
            options: "contrast=1.05:brightness=0.02:saturation=1.1",
            inputs: [`pts${i}`],
            outputs: [currentOutput],
          });
        }
      });

      // Concatenation for standard templates
      const concatInputs = clips.map((_, i) => `color${i}`);
      filterCommands.push({
        filter: "concat",
        options: `n=${clips.length}:v=1:a=0`,
        inputs: concatInputs,
        outputs: ["vconcat"],
      });

      lastOutput = "vconcat";
    }

    // Add audio if available
    if (musicIndex !== undefined && musicIndex >= 0) {
      filterCommands.push({
        filter: "atrim",
        options: `duration=${clips.reduce(
          (sum, clip) => sum + clip.duration,
          0
        )}`,
        inputs: [`${musicIndex}:a`],
        outputs: ["atrimmed"],
      });
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

    // Add watermark if available
    if (
      watermarkIndex !== undefined &&
      watermarkIndex >= 0 &&
      watermarkConfig
    ) {
      const position = watermarkConfig.position || {
        x: "(main_w-overlay_w)/2",
        y: "main_h-overlay_h-300",
      };
      filterCommands.push({
        filter: "overlay",
        options: `${position.x}:${position.y}`,
        inputs: [lastOutput, `${watermarkIndex}:v`],
        outputs: ["vout"],
      });
      lastOutput = "vout";
    }

    return filterCommands;
  }

  private createFFmpegCommand(): ffmpeg.FfmpegCommand {
    const command = ffmpeg();

    // Calculate optimal thread count based on available CPU cores
    // Use 75% of available cores, minimum 2, maximum 16
    const cpuCount = os.cpus().length;
    const threadCount = Math.max(2, Math.min(Math.floor(cpuCount * 0.75), 16));

    return command
      .outputOptions(["-threads", String(threadCount)]) // Use calculated thread count instead of hardcoded 1
      .on("start", async (commandLine) => {
        const codec = await this.getAvailableCodec();
        logger.info("FFmpeg process started", {
          commandLine,
          codec,
          activeJobs: ffmpegQueueManager.getActiveCount(),
          threadCount, // Log the thread count being used
        });
      })
      .on("progress", (progress) =>
        this.handleFFmpegProgress(progress, "video-processing")
      )
      .on("end", () => logger.info("FFmpeg process completed"))
      .on("error", (error: FFmpegError) =>
        this.handleFFmpegError(error, "video-processing")
      )
      .on("stderr", (stderrLine) => {
        // Only log as warning/error if it indicates a real issue
        if (
          stderrLine.includes("Error") &&
          !stderrLine.includes("successfully decoded") && // Ignore benign messages
          !stderrLine.includes("No such file") // Handle separately if needed
        ) {
          logger.warn("FFmpeg stderr critical message", { line: stderrLine });
        } else if (
          stderrLine.includes("Invalid") ||
          stderrLine.includes("Cannot") ||
          stderrLine.includes("failed") ||
          stderrLine.includes("unable to")
        ) {
          logger.warn("FFmpeg stderr critical message", { line: stderrLine });
        } else {
          logger.debug("FFmpeg stderr info", { line: stderrLine }); // Log benign messages as debug
        }
      })
      .outputOptions(["-v", "debug"]);
  }

  private handleFFmpegProgress(
    progress: FFmpegProgress,
    context: string
  ): void {
    // Calculate the current percentage rounded to the nearest integer
    const currentPercent = Math.round(progress.percent || 0);

    // Only log at 10% intervals or when frames are divisible by 30 for resource monitoring
    const shouldLogProgress =
      currentPercent % 10 === 0 &&
      (!this._lastLoggedPercent || currentPercent !== this._lastLoggedPercent);

    if (shouldLogProgress) {
      // Store the last logged percentage to avoid duplicate logs
      this._lastLoggedPercent = currentPercent;

      logger.info(`[${context}] Processing progress`, {
        ...progress,
        context,
        timestamp: new Date().toISOString(),
      });
    }

    // Log memory usage less frequently - every 90 frames instead of 30
    if (progress.frames % 90 === 0) {
      logger.info(`[${context}] Resource usage during encoding`, {
        ...this.getMemoryUsageInfo(),
        context,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private handleFFmpegError(error: FFmpegError, context: string): void {
    // Enhanced error logging
    const errorDetails = {
      message: error.message,
      code: error.code,
      exitCode: error.exitCode,
      killed: error.killed,
      cmd: error.cmd,
      stderr: error.stderr ? error.stderr.toString() : undefined,
      stdout: error.stdout ? error.stdout.toString() : undefined,
      details: error.details,
      timestamp: new Date().toISOString(),
    };

    // Extract FFmpeg specific error messages for better diagnostics
    if (errorDetails.stderr) {
      const errorLines = errorDetails.stderr
        .split("\n")
        .filter(
          (line) =>
            line.includes("Error") ||
            line.includes("error") ||
            line.includes("Invalid") ||
            line.includes("failed") ||
            line.includes("Could not") ||
            line.includes("Unable to")
        );

      if (errorLines.length > 0) {
        (errorDetails as any).errorLines = errorLines;
      }

      // Check for common FFmpeg errors
      if (errorDetails.stderr?.includes("Cannot allocate memory")) {
        (errorDetails as any).errorType = "OUT_OF_MEMORY";
      } else if (errorDetails.stderr?.includes("Too many packets buffered")) {
        (errorDetails as any).errorType = "BUFFER_OVERFLOW";
      } else if (errorDetails.stderr?.includes("Error while decoding")) {
        (errorDetails as any).errorType = "DECODE_ERROR";
      } else if (errorDetails.stderr?.includes("filters with the same name")) {
        (errorDetails as any).errorType = "FILTER_NAME_CONFLICT";
      } else if (errorDetails.stderr?.includes("Too many open files")) {
        (errorDetails as any).errorType = "TOO_MANY_FILES";
      }
    }

    logger.error(`[video-processing] FFmpeg error in ${context}`, errorDetails);

    // Log additional diagnostic information
    const memoryUsage = this.getMemoryUsageInfo();
    logger.error(`[video-processing] System state at error time`, {
      memoryUsage,
      activeJobs: ffmpegQueueManager
        ? ffmpegQueueManager.getActiveCount()
        : "unknown",
      queuedJobs: ffmpegQueueManager
        ? ffmpegQueueManager.getQueueLength()
        : "unknown",
      timestamp: new Date().toISOString(),
    });
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
    inputPaths: string[], // Keep this for compatibility, but adapt to clips internally
    outputPath: string,
    options: StitchOptions = {}
  ): Promise<void> {
    const jobId = crypto.randomUUID();
    if (!inputPaths.length || !outputPath) {
      throw new Error("Invalid input: No paths or output specified");
    }

    logger.info(`[${jobId}] Starting video stitching process`, {
      inputCount: inputPaths.length,
      outputPath,
      options,
    });

    // Convert inputPaths to VideoClip array (assuming default durations for now)
    const clips: VideoClip[] = await Promise.all(
      inputPaths.map(async (path, i) => {
        const duration = await this.getVideoDuration(path);
        return { path, duration: Math.min(duration, 5) }; // Cap at 5s for simplicity
      })
    );

    // Validate inputs
    const validationResults = await Promise.all(
      clips.map(async (clip) => ({
        path: clip.path,
        exists: await this.fileExists(clip.path),
        isValid: await this.validateVideoFile(clip.path),
      }))
    );
    const invalidFiles = validationResults.filter(
      (r) => !r.exists || !r.isValid
    );
    if (invalidFiles.length) {
      throw new Error(
        `Invalid inputs: ${invalidFiles.map((f) => f.path).join(", ")}`
      );
    }

    // Use reasonable defaults for timeout and retries
    const timeout = 120000; // 2 minutes
    const maxRetries = 2;

    await ffmpegQueueManager.enqueueJob(
      async () => {
        const command = this.createFFmpegCommand();

        // Add inputs
        clips.forEach((clip, i) => command.input(clip.path));

        // Build filter graph (no watermark or music for now; add later if needed)
        const filterGraph = this.buildFilterGraph(clips);
        if (!filterGraph) {
          throw new Error("Failed to build filter graph");
        }

        const codec = await this.getAvailableCodec();
        command
          .complexFilter(filterGraph)
          .outputOptions(["-map", "[vout]"]) // Map video output from filter graph
          .outputOptions([`-c:v ${codec}`, "-preset fast", "-crf 22"])
          .outputOptions(options.outputOptions || [])
          .output(outputPath);

        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            command.kill("SIGKILL");
            reject(new Error(`FFmpeg timed out after ${timeout}ms`));
          }, timeout);

          command
            .on("end", () => {
              clearTimeout(timeoutId);
              logger.info(`[${jobId}] Video stitching completed`, {
                outputPath,
              });
              resolve();
            })
            .on("error", (err) => {
              clearTimeout(timeoutId);
              this.handleFFmpegError(err, `${jobId} stitching`);
              reject(err);
            })
            .run();
        });

        // Validate output
        if (!(await this.validateVideoFile(outputPath))) {
          throw new Error(`Output validation failed: ${outputPath}`);
        }
      },
      timeout,
      maxRetries
    );
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
      // This works for both video and audio files
      return metadata.duration;
    } catch (error) {
      logger.error("Failed to get media duration", {
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

      // Check if this is likely an audio file
      const isAudioFile = !metadata.hasVideo && metadata.hasAudio;

      if (isAudioFile) {
        // For audio files, we only need valid audio and duration
        return metadata.hasAudio && metadata.duration > 0;
      }

      // For video files, we need valid video and duration
      return metadata.hasVideo && metadata.duration > 0;
    } catch (error) {
      logger.error("Media integrity check failed", {
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
      const metadata = await this.videoValidationService.validateVideo(
        filePath
      );

      if (!metadata.hasAudio) {
        logger.warn("Music file has no audio stream", {
          path: filePath,
        });
        return false;
      }

      if (metadata.duration <= 0) {
        logger.warn("Invalid music file duration", {
          path: filePath,
          duration: metadata.duration,
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
  private async createTempDirectory(): Promise<string> {
    const tempDir = path.join(this.TEMP_DIR, `temp_${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    logger.debug(`Created temporary directory: ${tempDir}`);
    return tempDir;
  }

  private normalizeProgress(
    progress: FFmpegProgress,
    totalDuration: number
  ): number {
    // Extract time from timemark (format: HH:MM:SS.MS)
    const timeMatch = progress.timemark.match(/(\d+):(\d+):(\d+)(?:\.(\d+))?/);
    if (!timeMatch) return 0;

    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseInt(timeMatch[3], 10);
    const milliseconds = timeMatch[4] ? parseInt(timeMatch[4], 10) / 100 : 0;

    const currentTimeInSeconds =
      hours * 3600 + minutes * 60 + seconds + milliseconds;

    // Calculate percentage based on current time and total duration
    const exactPercent = (currentTimeInSeconds / totalDuration) * 100;

    // Return the percentage rounded to the nearest integer
    return Math.min(Math.round(exactPercent), 100);
  }

  // In the `stitchVideoClips` method, update clip validation and filter generation
  public async stitchVideoClips(
    clips: VideoClip[],
    outputPath: string,
    template: VideoTemplate | ReelTemplate,
    watermarkConfig?: WatermarkConfig
  ): Promise<void> {
    const jobId = crypto.randomUUID();
    logger.info(`[${jobId}] Starting stitchVideoClips`, {
      clipCount: clips.length,
      templateName: template.name,
      outputPath,
      hasMusic: !!template.music,
      hasWatermark: !!watermarkConfig,
    });

    const isReelTemplate = "sequence" in template && "durations" in template;
    let processedClips = [...clips];

    if (template.name.toLowerCase() === "wesanderson") {
      processedClips = await Promise.all(
        processedClips.map((clip, i) =>
          this.preProcessWesAndersonClip(clip, i, jobId)
        )
      );
    }

    let sequenceClips: VideoClip[] = [];
    if (isReelTemplate) {
      const reelTemplate = template as ReelTemplate;
      const isGoogleZoomIntro = reelTemplate.name
        .toLowerCase()
        .includes("googlezoomintro");
      const durations = reelTemplate.durations;

      // Calculate target duration and max clips
      let targetDuration = 0;
      let maxClips = processedClips.length;
      if (Array.isArray(durations)) {
        targetDuration = durations.reduce((sum, d) => sum + d, 0);
        maxClips = Math.min(durations.length, processedClips.length);
      } else if (durations && typeof durations === "object") {
        // Handle object-based durations (e.g., googlezoomintro)
        const durationValues = Object.keys(durations)
          .filter((key) => key !== "map") // Exclude 'map' for now, handle separately
          .map((key) => durations[key as keyof typeof durations]);
        targetDuration =
          durationValues.reduce((sum, d) => sum + d, 0) + (durations.map || 0);
        maxClips = Math.min(
          durationValues.length + (durations.map ? 1 : 0),
          processedClips.length
        );
      }

      // Mejorar el logging para mostrar más información sobre la secuencia y los clips disponibles
      logger.info(`[${jobId}] Processing template ${reelTemplate.name}`, {
        sequenceLength: reelTemplate.sequence.length,
        availableClips: processedClips.length,
        maxClips,
        targetDuration,
        sequence: reelTemplate.sequence.slice(0, 20).join(","), // Mostrar parte de la secuencia para depuración
      });

      // The clips are already selected and ordered in productionPipeline.ts
      // Here we just need to ensure the durations are applied correctly
      sequenceClips = processedClips.map((clip, index) => {
        // Get the duration based on the position in the result (index)
        let duration;

        if (Array.isArray(durations)) {
          // Use the duration from the array based on the index
          duration =
            index < durations.length ? durations[index] : clip.duration;
        } else if (durations && typeof durations === "object") {
          // For object-based durations (like googlezoomintro)
          if (clip.isMapVideo && "map" in durations) {
            duration = durations.map;
          } else {
            // For numeric indices in the durations object
            const sequenceValue = isReelTemplate
              ? (reelTemplate.sequence[index] as string | number)
              : index;
            // Try to get duration using the sequence value first, then fall back to index
            duration =
              durations[sequenceValue as keyof typeof durations] ||
              durations[index as keyof typeof durations] ||
              clip.duration;
          }
        } else {
          duration = clip.duration;
        }

        // Log the duration assignment for debugging
        logger.debug(
          `[${jobId}] Assigning duration for clip at position ${index}`,
          {
            clipIndex: index,
            sequenceValue: isReelTemplate
              ? reelTemplate.sequence[index]
              : undefined,
            assignedDuration: duration,
            originalDuration: clip.duration,
            isMapVideo: clip.isMapVideo,
          }
        );

        return { ...clip, duration };
      });

      // Calculate total duration for logging purposes only
      const totalDuration = sequenceClips.reduce(
        (sum, clip) => sum + clip.duration,
        0
      );
      logger.info(`[${jobId}] Using exact template durations`, {
        totalDuration,
        clipCount: sequenceClips.length,
        validIndices: sequenceClips
          .map((clip, i) => `${i}:${clip.duration}`)
          .join(","),
      });
    } else {
      sequenceClips = processedClips;
    }

    // Validate and resolve paths for all clips
    const validClips = await Promise.all(
      sequenceClips.map(async (clip, index) => {
        const resolvedPath = await this.resolveAssetPath(
          clip.path,
          "video",
          true
        );
        const metadata = await this.getVideoMetadata(resolvedPath);
        if (!metadata.hasVideo || !metadata.duration) {
          throw new Error(`Clip at index ${index} is invalid`);
        }
        return { ...clip, path: resolvedPath, hasAudio: metadata.hasAudio };
      })
    );

    if (validClips.length === 0) throw new Error("No valid clips to stitch");

    const command = this.createFFmpegCommand();
    const totalDuration = validClips.reduce(
      (sum, clip) => sum + clip.duration,
      0
    );
    validClips.forEach((clip) => command.input(clip.path));

    const musicPath = template.music?.path
      ? await this.resolveAssetPath(template.music.path, "music", false)
      : undefined;
    const musicIndex = musicPath ? validClips.length : -1;
    if (musicPath) command.input(musicPath);

    const watermarkPath = watermarkConfig?.path
      ? await this.resolveAssetPath(watermarkConfig.path, "watermark", false)
      : undefined;
    const watermarkIndex = watermarkPath ? musicIndex + 1 : -1;
    if (watermarkPath) command.input(watermarkPath);

    const filterCommands =
      this.buildFilterGraph(
        validClips,
        watermarkConfig,
        musicIndex,
        watermarkIndex
      ) || [];
    command
      .complexFilter(filterCommands)
      .outputOptions(["-map", "[vconcat]"])
      .outputOptions(musicIndex !== -1 ? ["-map", "[aout]"] : [])
      .outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-r",
        String(TARGET_FRAME_RATE),
      ])
      .outputOptions(musicIndex !== -1 ? ["-c:a", "aac", "-b:a", "96k"] : [])
      .output(outputPath);

    await new Promise<void>((resolve, reject) => {
      const timeout = (template as ReelTemplate)?.timeout || 180000;
      const timeoutId = setTimeout(() => {
        command.kill("SIGKILL");
        reject(new Error(`FFmpeg timed out after ${timeout}ms`));
      }, timeout);

      command
        .on("end", () => {
          clearTimeout(timeoutId);
          logger.info(`[${jobId}] Video stitching completed`, {
            outputPath,
            totalDuration,
          });
          resolve();
        })
        .on("error", (err) => {
          clearTimeout(timeoutId);
          reject(err);
        })
        .run();
    });
  }

  // Helper method to normalize frame rate
  private async normalizeFrameRate(
    inputPath: string,
    outputPath: string,
    frameRate: number,
    jobId: string
  ): Promise<void> {
    await ffmpegQueueManager.enqueueJob(
      async () => {
        const command = this.createFFmpegCommand()
          .input(inputPath)
          .outputOptions(["-r", String(frameRate)])
          .output(outputPath);

        await new Promise<void>((resolve, reject) => {
          command
            .on("end", () => resolve())
            .on("error", (err) => reject(err))
            .run();
        });
      },
      60000,
      2
    );
  }

  // Helper method to get clip duration safely
  private getClipDuration(
    template: ReelTemplate,
    index: number,
    defaultDuration: number
  ): number {
    if (
      typeof template.durations === "object" &&
      !Array.isArray(template.durations)
    ) {
      // For object-based durations, try to get by index first, then by string index
      const objDurations = template.durations as Record<
        string | number,
        number
      >;
      return (
        objDurations[index] ?? objDurations[String(index)] ?? defaultDuration
      );
    } else if (Array.isArray(template.durations)) {
      return index < template.durations.length
        ? template.durations[index]
        : defaultDuration;
    }
    return defaultDuration;
  }

  /**
   * Builds a filter script for an FFmpeg filter file
   * This is used for complex templates to avoid command line length limitations
   */
  private buildFilterScript(
    clips: VideoClip[],
    hasMusic: boolean,
    hasWatermark: boolean
  ): string {
    const lines: string[] = [];

    // Process each clip
    clips.forEach((clip, i) => {
      // Trim operation
      lines.push(`[${i}:v]trim=duration=${clip.duration}[v${i}];`);

      // Set PTS
      lines.push(`[v${i}]setpts=PTS-STARTPTS[pts${i}];`);

      // Apply minimal color correction based on clip type
      const colorOptions = clip.isMapVideo
        ? "contrast=1.0:brightness=0.0:saturation=1.0" // Neutral for map videos
        : "contrast=1.05:brightness=0.02:saturation=1.1"; // Minimal for regular clips

      lines.push(`[pts${i}]eq=${colorOptions}[color${i}];`);
    });

    // Concatenation
    const concatInputs = clips.map((_, i) => `[color${i}]`).join("");
    lines.push(`${concatInputs}concat=n=${clips.length}:v=1:a=0[vconcat];`);

    // Add audio if present
    if (hasMusic) {
      const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
      lines.push(
        `[${clips.length}:a]atrim=duration=${totalDuration}[atrimmed];`
      );
      lines.push("[atrimmed]asetpts=PTS-STARTPTS[apts];");
      lines.push(
        "[apts]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout];"
      );
    }

    // Add watermark if present
    if (hasWatermark) {
      const watermarkIndex = hasMusic ? clips.length + 1 : clips.length;
      lines.push(
        `[vconcat][${watermarkIndex}:v]overlay=(main_w-overlay_w)/2:main_h-overlay_h-300[vout];`
      );
    }

    return lines.join("\n");
  }

  private getMemoryUsageInfo() {
    const memoryUsage = process.memoryUsage();
    return {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
    };
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validates a clip's duration and adjusts it if necessary
   * @param clip The video clip to validate
   * @param index The index of the clip in the sequence
   * @param jobId The job ID for logging
   * @param template Optional template with duration information
   * @returns True if the clip is valid, false otherwise
   */
  public async validateClipDuration(
    clip: VideoClip,
    index: number,
    jobId: string,
    template?: ReelTemplate
  ): Promise<boolean> {
    try {
      const duration = await this.getVideoDuration(clip.path);

      // Get expected duration from template if available
      const expectedDuration = template?.durations[index];
      const requestedDuration = clip.duration;

      // If the requested duration is longer than actual video duration
      if (requestedDuration > duration) {
        logger.warn(
          `[${jobId}] Clip ${index} requested duration exceeds actual duration`,
          {
            clipPath: clip.path,
            requestedDuration,
            actualDuration: duration,
            templateDuration: expectedDuration,
          }
        );

        // Adjust the clip duration to actual duration
        clip.duration = duration;
      }

      return true;
    } catch (error) {
      logger.error(`[${jobId}] Failed to validate clip ${index} duration`, {
        clipPath: clip.path,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  private async getAvailableCodec(): Promise<string> {
    if (this._cachedCodec) {
      return this._cachedCodec;
    }

    // Try hardware acceleration first, then fallback to software
    try {
      // Try h264_videotoolbox (Mac)
      const isVideotoolboxAvailable = await this.checkCodecAvailability(
        "h264_videotoolbox"
      );
      if (isVideotoolboxAvailable) {
        this._cachedCodec = "h264_videotoolbox";
        return this._cachedCodec;
      }

      // Try VAAPI (Linux)
      const isVaapiAvailable = await this.checkCodecAvailability("h264_vaapi");
      if (isVaapiAvailable) {
        this._cachedCodec = "h264_vaapi";
        return this._cachedCodec;
      }

      // Fallback to software encoding
      this._cachedCodec = "libx264";
      return this._cachedCodec;
    } catch (error) {
      logger.warn(
        "Error checking codec availability, falling back to libx264",
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      this._cachedCodec = "libx264";
      return this._cachedCodec;
    }
  }

  private async checkCodecAvailability(codec: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const command = ffmpeg();
      command
        .outputOptions([`-c:v ${codec}`])
        .output("/dev/null") // Output to nowhere
        .noAudio()
        .inputOptions(["-f", "lavfi", "-i", "color=c=black:s=1280x720:d=0.1"])
        .on("start", () => {
          command.kill("SIGKILL");
          resolve(true);
        })
        .on("error", () => {
          resolve(false);
        })
        .run();
    });
  }

  /**
   * Preprocesses a clip for the Wes Anderson template
   * Applies specific color grading and effects to match the Wes Anderson style
   */
  public async preProcessWesAndersonClip(
    clip: VideoClip,
    index: number,
    jobId: string
  ): Promise<VideoClip> {
    const tempPath = path.join(
      this.TEMP_DIR,
      `preprocessed_${jobId}_${index}.mp4`
    );

    logger.info(`[${jobId}] Pre-processing Wes Anderson clip ${index}`, {
      inputPath: clip.path,
      outputPath: tempPath,
      duration: clip.duration,
    });

    try {
      // Track the temporary file for cleanup
      resourceManager.trackResource(jobId, tempPath);

      // Check system resources
      const memoryUsage = process.memoryUsage();
      logger.debug(`[${jobId}] Pre-processing resources for clip ${index}`, {
        memory: {
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        },
      });

      // Use reasonable defaults for timeout and retries
      const timeout = 120000; // 2 minutes
      const maxRetries = 2;

      await ffmpegQueueManager.enqueueJob(
        async () => {
          const command = this.createFFmpegCommand()
            .input(clip.path)
            .complexFilter([
              {
                filter: "trim",
                options: `duration=${clip.duration}`,
                outputs: ["trimmed"],
              },
              {
                filter: "setpts",
                options: "PTS-STARTPTS",
                inputs: ["trimmed"],
                outputs: ["pts"],
              },
              {
                filter: "eq",
                options:
                  "brightness=0.03:contrast=1.09:saturation=1.18:gamma=0.97",
                inputs: ["pts"],
                outputs: ["eq"],
              },
              {
                filter: "hue",
                options: "h=3:s=1.12",
                inputs: ["eq"],
                outputs: ["hue"],
              },
              {
                filter: "colorbalance",
                options: "rm=0.06:gm=-0.03:bm=-0.06",
                inputs: ["hue"],
                outputs: ["cb"],
              },
              {
                filter: "curves",
                options: "master='0/0 0.2/0.15 0.5/0.55 0.8/0.85 1/1'",
                inputs: ["cb"],
                outputs: ["curves"],
              },
              {
                filter: "unsharp",
                options: "5:5:1.5:5:5:0.0",
                inputs: ["curves"],
                outputs: ["unsharp"],
              },
              {
                filter: "format",
                options: "yuv420p",
                inputs: ["unsharp"],
                outputs: ["final"],
              },
            ])
            .outputOptions(["-map", "[final]"])
            .outputOptions(["-c:v", "libx264", "-preset", "fast", "-crf", "23"])
            .output(tempPath);

          await new Promise<void>((resolve, reject) => {
            command
              .on("end", () => {
                logger.info(
                  `[${jobId}] Pre-processed Wes Anderson clip ${index}`,
                  {
                    tempPath,
                  }
                );
                resolve();
              })
              .on("error", (err) => {
                logger.error(
                  `[${jobId}] Pre-processing failed for clip ${index}`,
                  {
                    error: err.message,
                    path: clip.path,
                  }
                );
                reject(err);
              })
              .run();
          });
        },
        timeout,
        maxRetries
      );

      // Validate the processed clip
      const processedClip = { ...clip, path: tempPath };
      const isValid = await this.validateClipDuration(
        processedClip,
        index,
        jobId
      );

      if (!isValid) {
        throw new Error(`Processed clip ${index} failed validation`);
      }

      return processedClip;
    } catch (error) {
      logger.error(
        `[${jobId}] Error in preProcessWesAndersonClip for clip ${index}`,
        {
          error: error instanceof Error ? error.message : String(error),
          path: clip.path,
        }
      );

      // Validate the original clip as fallback
      const isOriginalValid = await this.validateClipDuration(
        clip,
        index,
        jobId
      );
      return isOriginalValid ? clip : { ...clip, path: "" }; // Empty path signals skip
    }
  }

  // Add method to clean up segment cache
  private cleanupSegmentCache(forceCleanAll: boolean = false): void {
    logger.debug(`Cleaning up segment cache. Force clean: ${forceCleanAll}`);
    if (forceCleanAll) {
      // Clear all cached segments
      this.segmentCache.clear();
      logger.debug("Segment cache completely cleared");
      return;
    }

    // Clean up old segments (older than 1 hour)
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    // Since Map doesn't store timestamps, we'll need to check the files
    const segmentsToRemove: string[] = [];

    this.segmentCache.forEach(async (filePath, key) => {
      try {
        // Use statSync from the fs import, not fs/promises
        const stats = statSync(filePath);
        if (now - stats.mtimeMs > ONE_HOUR) {
          segmentsToRemove.push(key);
          // Try to delete the file
          try {
            // Use unlinkSync from fs, not fs/promises
            fs.unlink(filePath).catch((err) => {
              logger.warn(`Failed to delete cached segment file: ${filePath}`, {
                error: err,
              });
            });
            logger.debug(`Removed cached segment file: ${filePath}`);
          } catch (err) {
            logger.warn(`Failed to delete cached segment file: ${filePath}`, {
              error: err,
            });
          }
        }
      } catch (err) {
        // File doesn't exist anymore, remove from cache
        segmentsToRemove.push(key);
        logger.debug(`Removing non-existent file from cache: ${filePath}`);
      }
    });

    // Remove keys from cache
    segmentsToRemove.forEach((key) => {
      this.segmentCache.delete(key);
    });

    logger.debug(
      `Segment cache cleanup complete. Removed ${segmentsToRemove.length} entries. Remaining: ${this.segmentCache.size}`
    );
  }
}

export const videoProcessingService = VideoProcessingService.getInstance();
