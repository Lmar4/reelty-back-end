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

    // Handle S3/HTTPS URLs
    if (assetPath.startsWith("https://") || assetPath.startsWith("s3://")) {
      const normalizedPath = assetPath.startsWith("s3://")
        ? assetPath.replace("s3://", "https://")
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

    clips.forEach((clip, i) => {
      const baseInput = `${i}:v`;
      let currentInput = baseInput;
      let currentOutput = `clip${i}`;

      // Trim and reset PTS
      filterCommands.push({
        filter: "trim",
        options: { duration: clip.duration.toString() },
        inputs: [currentInput],
        outputs: [`trim${i}`],
      });
      filterCommands.push({
        filter: "setpts",
        options: "PTS-STARTPTS",
        inputs: [`trim${i}`],
        outputs: [currentOutput],
      });
      currentInput = currentOutput;

      // Apply color correction for Wes Anderson
      if (clip.colorCorrection?.ffmpegFilter?.includes("curves=master")) {
        const filters = [
          {
            filter: "eq",
            options: "brightness=0.05:contrast=1.15:saturation=1.3:gamma=0.95",
            output: `eq${i}`,
          },
          { filter: "hue", options: "h=5:s=1.2", output: `hue${i}` },
          {
            filter: "colorbalance",
            options: "rm=0.1:gm=-0.05:bm=-0.1",
            output: `cb${i}`,
          },
          {
            filter: "curves",
            options: { master: "0/0 0.2/0.15 0.5/0.55 0.8/0.85 1/1" },
            output: `curves${i}`,
          },
          {
            filter: "unsharp",
            options: "5:5:1.5:5:5:0.0",
            output: currentOutput,
          },
        ];

        filters.forEach((f, idx) => {
          const input = idx === 0 ? currentInput : filters[idx - 1].output;
          filterCommands.push({
            filter: f.filter,
            options: f.options,
            inputs: [input],
            outputs: [f.output],
          });
        });
      } else if (clip.colorCorrection?.ffmpegFilter) {
        filterCommands.push({
          filter: "eq",
          options: clip.colorCorrection.ffmpegFilter.replace("eq=", ""),
          inputs: [currentInput],
          outputs: [currentOutput],
        });
      }

      // Transitions (simplified for now)
      if (i > 0 && clip.transition) {
        filterCommands.push({
          filter: "xfade",
          options: {
            transition: clip.transition.type,
            duration: clip.transition.duration.toString(),
          },
          inputs: [lastOutput, currentOutput],
          outputs: [`trans${i}`],
        });
        lastOutput = `trans${i}`;
      } else {
        lastOutput = currentOutput;
      }
    });

    // Concatenation
    if (clips.length > 1) {
      const inputs = clips.map((_, i) =>
        lastOutput.includes("trans") ? `trans${i}` : `clip${i}`
      );
      filterCommands.push({
        filter: "concat",
        options: { n: inputs.length.toString(), v: "1", a: "0" },
        inputs,
        outputs: ["vout"],
      });
    } else {
      filterCommands.push({
        filter: "null",
        inputs: [lastOutput],
        outputs: ["vout"],
      });
    }

    return filterCommands;
  }

  private createFFmpegCommand(): ffmpeg.FfmpegCommand {
    const command = ffmpeg();
    return command
      .outputOptions(["-threads", "1"])
      .on("start", async (commandLine) => {
        const codec = await this.getAvailableCodec();
        logger.info("FFmpeg process started", {
          commandLine,
          codec,
          activeJobs: ffmpegQueueManager.getActiveCount(),
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
        if (
          stderrLine.includes("Error") ||
          stderrLine.includes("Invalid") ||
          stderrLine.includes("Cannot") ||
          stderrLine.includes("failed") ||
          stderrLine.includes("unable to")
        ) {
          logger.warn("FFmpeg stderr critical message", { line: stderrLine });
        }
      })
      .outputOptions(["-v", "debug"]);
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
        activeFFmpegJobs: ffmpegQueueManager.getActiveCount(),
        queuedJobs: ffmpegQueueManager.getQueueLength(),
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
      const lastErrorLine = String(details.lastErrorLine);
      const filterMatch = lastErrorLine.match(
        /(Parsed_[a-z]+_\d+)|auto_scale_\d+/
      );
      if (filterMatch) {
        enhancedMessage += ` (Failed Filter: ${filterMatch[0]})`;
        details.failedFilter = filterMatch[0];
      }
    }

    const enrichedError = new Error(enhancedMessage) as Error & {
      details?: Record<string, any>;
    };
    enrichedError.details = details;
    throw enrichedError;
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

  // Update the stitchVideoClips method to use the cached segments and the copyToTempIfNeeded helper.
  public async stitchVideoClips(
    clips: VideoClip[],
    outputPath: string,
    template: VideoTemplate | ReelTemplate,
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
      memoryUsage: this.getMemoryUsageInfo(),
      activeFFmpegJobs: ffmpegQueueManager.getActiveCount(),
      queuedJobs: ffmpegQueueManager.getQueueLength(),
    });

    try {
      const isReelTemplate = "sequence" in template && "durations" in template;

      // Pre-process clips for Wes Anderson template
      let processedClips = [...clips];
      if (template.name.toLowerCase() === "wesanderson") {
        logger.info(`[${jobId}] Pre-processing Wes Anderson clips`, {
          clipCount: processedClips.length,
        });
        processedClips = await Promise.all(
          processedClips.map((clip, i) =>
            this.preProcessWesAndersonClip(clip, i, jobId)
          )
        );
        logger.info(`[${jobId}] Completed pre-processing Wes Anderson clips`);
      }

      let sequenceClips = [...processedClips];
      if (isReelTemplate) {
        const reelTemplate = template as ReelTemplate;
        if (reelTemplate.sequence && Array.isArray(reelTemplate.sequence)) {
          sequenceClips = reelTemplate.sequence
            .map((seq, index) => {
              const clipIndex =
                typeof seq === "string"
                  ? seq === "map"
                    ? 0
                    : parseInt(seq, 10)
                  : seq;
              const clip = processedClips[clipIndex];
              if (!clip) {
                logger.warn(`[${jobId}] Missing clip at sequence ${index}`, {
                  sequence: seq,
                });
                return null;
              }
              const duration = Array.isArray(reelTemplate.durations)
                ? reelTemplate.durations[index]
                : reelTemplate.durations[seq];
              return { ...clip, duration: duration || clip.duration };
            })
            .filter(Boolean) as VideoClip[];
        }
      }

      const validatedClips = await Promise.all(
        sequenceClips.map(async (clip, index) => {
          if (!clip || !clip.path) {
            logger.warn(
              `[${jobId}] Skipping missing clip at sequence ${index}`,
              {
                sequence: isReelTemplate
                  ? (template as ReelTemplate).sequence[index]
                  : index,
              }
            );
            return null;
          }

          const resolvedPath =
            clip.path.startsWith("http") || clip.path.startsWith("s3://")
              ? await this.resolveAssetPath(clip.path, "video", true)
              : clip.path;

          const metadata = await this.getVideoMetadata(resolvedPath);
          if (!metadata.hasVideo || !metadata.duration) {
            logger.warn(`[${jobId}] Skipping invalid clip ${index}`, {
              path: resolvedPath,
            });
            return null;
          }
          clip.duration = clip.duration || metadata.duration;

          const isMapVideo =
            resolvedPath.includes("/maps/") ||
            resolvedPath.includes("map") ||
            (isReelTemplate &&
              (template as ReelTemplate).sequence[index] === "map") ||
            (template.name.toLowerCase().includes("google zoom") &&
              index === 0);

          logger.info(`[${jobId}] Validated clip ${index}`, {
            path: resolvedPath,
            duration: clip.duration,
            hasAudio: metadata.hasAudio,
            isMapVideo,
            sequence: isReelTemplate
              ? (template as ReelTemplate).sequence[index]
              : index,
          });

          return {
            ...clip,
            path: resolvedPath,
            hasAudio: metadata.hasAudio,
            isMapVideo,
          };
        })
      );

      const validClips = validatedClips.filter(
        (clip): clip is NonNullable<typeof clip> => clip !== null
      );
      if (validClips.length === 0) {
        throw new Error("No valid clips to stitch");
      }

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
        }
      }

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
          } else {
            logger.info(`[${jobId}] Validated watermark`, {
              path: watermarkPath,
            });
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

      const command = this.createFFmpegCommand();
      const totalDuration = validClips.reduce(
        (sum, clip) => sum + clip.duration,
        0
      );

      validClips.forEach((clip) => command.input(clip.path));
      const musicIndex = musicPath ? validClips.length : -1;
      if (musicPath) command.input(musicPath);
      const watermarkIndex = watermarkPath
        ? musicIndex !== -1
          ? musicIndex + 1
          : validClips.length
        : -1;
      if (watermarkPath) command.input(watermarkPath);

      const filterCommands: ffmpeg.FilterSpecification[] = [];
      validClips.forEach((clip, i) => {
        filterCommands.push({
          filter: "trim",
          options: `duration=${clip.duration}`,
          inputs: [`${i}:v`],
          outputs: [`v${i}`],
        });
        filterCommands.push({
          filter: "setpts",
          options: "PTS-STARTPTS",
          inputs: [`v${i}`],
          outputs: [`pts${i}`],
        });

        let currentInput = `pts${i}`;
        let currentOutput = `color${i}`;

        // Special handling for Wes Anderson template
        if (template.name.toLowerCase() === "wesanderson" && !processedClips) {
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

          // Apply curves filter
          filterCommands.push({
            filter: "curves",
            options: "master='0/0 0.2/0.15 0.5/0.55 0.8/0.85 1/1'",
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
        } else if (
          "colorCorrection" in template &&
          template.colorCorrection?.ffmpegFilter
        ) {
          // For other templates with color correction
          filterCommands.push({
            filter: "eq",
            options: template.colorCorrection.ffmpegFilter,
            inputs: [currentInput],
            outputs: [currentOutput],
          });
        } else if (clip.colorCorrection?.ffmpegFilter) {
          // Use clip-specific color correction if available
          filterCommands.push({
            filter: "eq",
            options: clip.colorCorrection.ffmpegFilter,
            inputs: [currentInput],
            outputs: [currentOutput],
          });
        } else {
          // Default mild color correction
          filterCommands.push({
            filter: "eq",
            options: "contrast=1.05:brightness=0.02:saturation=1.1",
            inputs: [currentInput],
            outputs: [currentOutput],
          });
        }
      });

      const concatInputs = validClips.map((_, i) => `color${i}`);

      // Add format filter to ensure pixel format compatibility
      if (template.name.toLowerCase() === "wesanderson") {
        filterCommands.push({
          filter: "format",
          options: "yuv420p",
          inputs: [concatInputs[concatInputs.length - 1]],
          outputs: ["formatted_last"],
        });
        concatInputs[concatInputs.length - 1] = "formatted_last";
      }

      filterCommands.push({
        filter: "concat",
        options: `n=${validClips.length}:v=1:a=0`,
        inputs: concatInputs,
        outputs: ["vconcat"],
      });

      let finalVideoOutput = "vconcat";

      // Add format filter after concat for Wes Anderson template
      if (template.name.toLowerCase() === "wesanderson") {
        filterCommands.push({
          filter: "format",
          options: "yuv420p",
          inputs: [finalVideoOutput],
          outputs: ["formatted"],
        });
        finalVideoOutput = "formatted";
      }

      if (musicIndex !== -1) {
        filterCommands.push({
          filter: "atrim",
          options: `duration=${totalDuration}`,
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

      if (watermarkIndex !== -1) {
        const position = watermarkConfig?.position || {
          x: "(main_w-overlay_w)/2",
          y: "main_h-overlay_h-300",
        };
        filterCommands.push({
          filter: "overlay",
          options: `${position.x}:${position.y}`,
          inputs: [finalVideoOutput, `${watermarkIndex}:v`],
          outputs: ["vout"],
        });
        finalVideoOutput = "vout";
      }

      command.complexFilter(filterCommands);
      command.outputOptions(["-map", `[${finalVideoOutput}]`]);
      if (musicIndex !== -1) {
        command.outputOptions(["-map", "[aout]"]);
      }

      command.outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-threads",
        "2", // Limit threads to reduce CPU load
      ]);
      if (musicIndex !== -1) {
        command.outputOptions(["-c:a", "aac", "-b:a", "96k"]);
      }

      if ("outputOptions" in template && template.outputOptions) {
        template.outputOptions.forEach((opt: string) =>
          command.outputOptions(opt)
        );
      }

      command.output(outputPath);

      await new Promise<void>((resolve, reject) => {
        const stderrBuffer: string[] = [];
        command
          .on("start", (commandLine) =>
            logger.info(`[${jobId}] FFmpeg started`, { commandLine })
          )
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
            err.stderr = stderrBuffer.join("\n") || err.stderr;
            logger.error(`[${jobId}] FFmpeg error in stitchVideoClips`, {
              error: err.message,
              stderr: err.stderr,
            });
            reject(err);
          })
          .on("stderr", (stderrLine) => {
            stderrBuffer.push(stderrLine);
            if (
              stderrLine.includes("Error") ||
              stderrLine.includes("Invalid") ||
              stderrLine.includes("Cannot") ||
              stderrLine.includes("failed")
            ) {
              logger.warn(`[${jobId}] FFmpeg stderr critical message`, {
                line: stderrLine,
              });
            }
          })
          .run();
      });

      await this.validateFile(outputPath, "Output video");
      logger.info(`[${jobId}] Successfully created video`, { outputPath });

      // Clean up resources
      if (template.name.toLowerCase() === "wesanderson") {
        await resourceManager.cleanup(jobId);
        logger.info(`[${jobId}] Cleaned up pre-processed Wes Anderson clips`);
      }

      logger.info(`[${jobId}] Completed stitchVideoClips`, {
        outputPath,
        duration: totalDuration,
      });
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

  /**
   * Cleans up the segment cache to free memory and disk space
   * @param forceCleanAll If true, removes all cached segments, otherwise only removes unused ones
   */
  private async cleanupSegmentCache(
    forceCleanAll: boolean = false
  ): Promise<void> {
    try {
      const cacheSize = this.segmentCache.size;
      if (cacheSize === 0) return;

      logger.info("Starting segment cache cleanup", {
        cacheSize,
        forceCleanAll,
      });

      // Validate cache entries
      for (const [url, filePath] of this.segmentCache.entries()) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.size === 0) {
            logger.warn("Cached file is empty, removing", { url, filePath });
            await fs.unlink(filePath);
            this.segmentCache.delete(url);
          }
        } catch (error) {
          logger.warn("Cached file invalid, removing", {
            url,
            filePath,
            error,
          });
          this.segmentCache.delete(url);
        }
      }

      // If force clean, remove all cached segments
      if (forceCleanAll) {
        // Delete all cached files
        for (const [url, filePath] of this.segmentCache.entries()) {
          try {
            if (existsSync(filePath)) {
              await fs.unlink(filePath);
            }
          } catch (error) {
            logger.warn(`Failed to delete cached file: ${filePath}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Clear the cache map
        this.segmentCache.clear();
        logger.info("Segment cache completely cleared");
        return;
      }

      // Otherwise, implement a simple LRU-like cleanup
      // For now, just keep the cache size under control (e.g., max 100 items)
      const MAX_CACHE_SIZE = 100;
      if (cacheSize > MAX_CACHE_SIZE) {
        // Get all entries as an array
        const entries = Array.from(this.segmentCache.entries());

        // Remove oldest entries (first ones in the map)
        const entriesToRemove = entries.slice(0, cacheSize - MAX_CACHE_SIZE);

        for (const [url, filePath] of entriesToRemove) {
          try {
            if (existsSync(filePath)) {
              await fs.unlink(filePath);
            }
            this.segmentCache.delete(url);
          } catch (error) {
            logger.warn(
              `Failed to delete cached file during cleanup: ${filePath}`,
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        logger.info("Segment cache partially cleaned up", {
          removedCount: entriesToRemove.length,
          newCacheSize: this.segmentCache.size,
        });
      }
    } catch (error) {
      logger.error("Error during segment cache cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get statistics about the segment cache
   * @returns Object containing cache statistics
   */
  public getSegmentCacheStats(): {
    size: number;
    urls: string[];
    totalSizeBytes: number;
  } {
    try {
      const urls = Array.from(this.segmentCache.keys());
      let totalSizeBytes = 0;

      // Calculate total size of cached files
      for (const filePath of this.segmentCache.values()) {
        try {
          if (existsSync(filePath)) {
            const stats = statSync(filePath);
            totalSizeBytes += stats.size;
          }
        } catch (error) {
          // Ignore errors when getting file stats
        }
      }

      return {
        size: this.segmentCache.size,
        urls,
        totalSizeBytes,
      };
    } catch (error) {
      logger.error("Error getting segment cache stats", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        size: 0,
        urls: [],
        totalSizeBytes: 0,
      };
    }
  }

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
            options: "brightness=0.05:contrast=1.15:saturation=1.3:gamma=0.95",
            inputs: ["pts"],
            outputs: ["eq"],
          },
          {
            filter: "hue",
            options: "h=5:s=1.2",
            inputs: ["eq"],
            outputs: ["hue"],
          },
          {
            filter: "colorbalance",
            options: "rm=0.1:gm=-0.05:bm=-0.1",
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
            logger.info(`[${jobId}] Pre-processed Wes Anderson clip ${index}`, {
              tempPath,
            });
            resolve();
          })
          .on("error", (err) => {
            logger.error(`[${jobId}] Pre-processing failed for clip ${index}`, {
              error: err.message,
              path: clip.path,
            });
            reject(err);
          })
          .run();
      });

      return { ...clip, path: tempPath };
    } catch (error) {
      logger.error(
        `[${jobId}] Error in preProcessWesAndersonClip for clip ${index}`,
        {
          error: error instanceof Error ? error.message : String(error),
          path: clip.path,
        }
      );
      // If pre-processing fails, return the original clip
      return clip;
    }
  }

  private getMemoryUsageInfo() {
    try {
      const memoryUsage = process.memoryUsage();
      return {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
      };
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch (error) {
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
}

export const videoProcessingService = VideoProcessingService.getInstance();
