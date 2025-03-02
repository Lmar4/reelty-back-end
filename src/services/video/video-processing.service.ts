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
  private s3Service: S3Service;
  private s3VideoService: S3VideoService;
  private videoValidationService: VideoValidationService;
  private readonly FFmpeg_TIMEOUT = 60 * 60 * 1000; // 1 hour timeout

  private constructor() {
    this.s3Service = new S3Service();
    this.s3VideoService = S3VideoService.getInstance();
    this.videoValidationService = VideoValidationService.getInstance();
    if (!existsSync(this.TEMP_DIR)) {
      mkdirSync(this.TEMP_DIR, { recursive: true });
      logger.info("Created TEMP_DIR", { path: this.TEMP_DIR });
    }
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
    return (
      ffmpeg()
        .on("start", (commandLine) => {
          logger.info("FFmpeg process started", { commandLine });
        })
        .on("progress", (progress) =>
          this.handleFFmpegProgress(progress, "video-processing")
        )
        .on("end", () => logger.info("FFmpeg process completed"))
        .on("error", (error: FFmpegError) =>
          this.handleFFmpegError(error, "video-processing")
        )
        .on("stderr", (stderrLine) => {
          // Enhanced FFmpeg stderr logging
          logger.debug("FFmpeg stderr output", {
            line: stderrLine,
            timestamp: new Date().toISOString(),
          });
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

    // Add stderr if available
    if (error.stderr) {
      details.stderr = error.stderr;
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
        logger.warn("S3 upload or verification attempt failed", {
          filePath,
          s3Key,
          attempt,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (attempt === MAX_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    throw new Error("S3 upload failed after retries");
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

  public async stitchVideos(
    clips: VideoClip[],
    outputPath: string,
    template: VideoTemplate,
    watermarkConfig?: WatermarkConfig,
    progressEmitter?: EventEmitter
  ): Promise<void> {
    const startTime = Date.now();
    const jobId = crypto.randomUUID();
    const tempFiles: string[] = []; // Track files for cleanup

    logger.info(
      `[${jobId}] Starting video stitching with enhanced validation`,
      {
        clipCount: clips.length,
        outputPath,
        templateName: template.name,
        hasWatermark: !!watermarkConfig,
        hasMusic: !!template.music?.path,
      }
    );

    const validatedClips = await Promise.all(
      clips.map(async (clip, index) => {
        try {
          if (!clip.path) {
            throw new Error(`Clip ${index} has no path`);
          }

          const resolvedPath =
            clip.path.startsWith("http") || clip.path.startsWith("s3://")
              ? await this.resolveAssetPath(clip.path, "video", true)
              : clip.path;
          tempFiles.push(resolvedPath);

          await this.validateFile(resolvedPath, `Clip ${index}`);
          if (!clip.duration || clip.duration <= 0) {
            const duration = await this.getVideoDuration(resolvedPath);
            if (duration <= 0) {
              throw new Error(
                `Invalid duration for clip ${index}: ${duration}`
              );
            }
            clip.duration = duration;
          }

          if (clip.transition) {
            if (
              !["crossfade", "fade", "slide"].includes(clip.transition.type)
            ) {
              logger.warn(
                `Invalid transition type for clip ${index}, defaulting to crossfade`,
                { type: clip.transition.type }
              );
              clip.transition.type = "crossfade";
            }
            if (!clip.transition.duration || clip.transition.duration <= 0) {
              logger.warn(
                `Invalid transition duration for clip ${index}, defaulting to 0.5s`,
                { duration: clip.transition.duration }
              );
              clip.transition.duration = 0.5;
            }
          }

          logger.info(`[${jobId}] Validated clip ${index}`, {
            path: resolvedPath,
            duration: clip.duration,
            hasTransition: !!clip.transition,
          });
          return { ...clip, path: resolvedPath };
        } catch (error) {
          logger.error(`[${jobId}] Clip ${index} validation failed`, {
            path: clip.path,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      })
    );

    let validatedMusic = template.music;
    if (template.music?.path) {
      try {
        const musicPath = await this.resolveAssetPath(
          template.music.path,
          "music",
          true
        );
        tempFiles.push(musicPath);
        await this.validateFile(musicPath, "Music");
        validatedMusic = { ...template.music, path: musicPath };
        logger.info(`[${jobId}] Validated music file`, { path: musicPath });
      } catch (error) {
        logger.warn(
          `[${jobId}] Music validation failed, proceeding without music`,
          {
            path: template.music.path,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );
        validatedMusic = undefined;
      }
    }

    let validatedWatermark = watermarkConfig;
    if (watermarkConfig?.path) {
      try {
        const watermarkPath = await this.resolveAssetPath(
          watermarkConfig.path,
          "watermark",
          true
        );
        tempFiles.push(watermarkPath);
        await this.validateFile(watermarkPath, "Watermark");
        validatedWatermark = { ...watermarkConfig, path: watermarkPath };
        logger.info(`[${jobId}] Validated watermark file`, {
          path: watermarkPath,
        });
      } catch (error) {
        logger.warn(
          `[${jobId}] Watermark validation failed, proceeding without watermark`,
          {
            path: watermarkConfig.path,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );
        validatedWatermark = undefined;
      }
    }

    const totalDuration = validatedClips.reduce(
      (sum, clip) => sum + clip.duration,
      0
    );

    return new Promise((resolve, reject) => {
      const command = this.createFFmpegCommand();
      let filterInfo: string[] = [];

      const setupCommand = async () => {
        try {
          // Ensure all inputs exist before proceeding
          for (const clip of validatedClips) {
            await fs.access(clip.path, fs.constants.R_OK);
          }

          for (const [i, clip] of validatedClips.entries()) {
            command.input(clip.path);
            logger.info(`[${jobId}] Added input ${i}: ${clip.path}`);
          }

          let musicIndex = -1;
          if (validatedMusic?.path) {
            musicIndex = validatedClips.length;
            command.input(validatedMusic.path);
            logger.info(
              `[${jobId}] Added music input at index ${musicIndex}: ${validatedMusic.path}`
            );
          }

          let watermarkIndex = -1;
          if (validatedWatermark?.path) {
            watermarkIndex =
              musicIndex !== -1 ? musicIndex + 1 : validatedClips.length;
            command
              .input(validatedWatermark.path)
              .inputOptions(["-loop", "1", "-framerate", "24", "-f", "image2"]);
            logger.info(
              `[${jobId}] Added watermark input at index ${watermarkIndex}: ${validatedWatermark.path}`
            );
          }

          // Simplified filter graph: basic concat with music and watermark
          const filterGraph: ffmpeg.FilterSpecification[] = [];
          validatedClips.forEach((clip, i) => {
            filterGraph.push({
              filter: "trim",
              options: `duration=${clip.duration}`,
              inputs: [`${i}:v`],
              outputs: [`v${i}`],
            });
          });
          filterGraph.push({
            filter: "concat",
            options: `n=${validatedClips.length}:v=1:a=0`,
            inputs: validatedClips.map((_, i) => `v${i}`),
            outputs: ["vconcat"],
          });
          if (musicIndex !== -1) {
            filterGraph.push({
              filter: "atrim",
              options: `duration=${totalDuration}`,
              inputs: [`${musicIndex}:a`],
              outputs: ["aout"],
            });
          }
          if (watermarkIndex !== -1) {
            filterGraph.push({
              filter: "overlay",
              options: "(main_w-overlay_w)/2:main_h-overlay_h-300",
              inputs: ["vconcat", `${watermarkIndex}:v`],
              outputs: ["vout"],
            });
          } else {
            filterGraph.push({
              filter: "null",
              inputs: ["vconcat"],
              outputs: ["vout"],
            });
          }

          filterInfo = filterGraph.map((f) => `${f.filter}:${f.options}`);
          command.complexFilter(filterGraph);
          logger.info(
            `[${jobId}] Applied simplified filter graph with ${filterGraph.length} filters`
          );

          const hasAudioInput = await Promise.all(
            validatedClips.map(
              async (clip) => (await this.getVideoMetadata(clip.path)).hasAudio
            )
          ).then((results) => results.some(Boolean));

          command
            .videoCodec("libx264")
            .audioCodec("aac")
            .outputOptions([
              "-map [vout]",
              ...(musicIndex !== -1 && (hasAudioInput || validatedMusic)
                ? ["-map [aout]"]
                : []),
              "-shortest",
              "-pix_fmt yuv420p",
              "-movflags +faststart",
              "-preset medium",
              "-crf 23",
              "-r 24",
            ]);

          if (template.outputOptions) {
            command.outputOptions(template.outputOptions);
          }

          const localOutput = outputPath.startsWith("https://")
            ? path.join(this.TEMP_DIR, `temp_output_${crypto.randomUUID()}.mp4`)
            : outputPath;
          tempFiles.push(localOutput);

          const fullCommand = command._getArguments().join(" ");
          logger.info(`[${jobId}] Full FFmpeg command:`, {
            command: fullCommand,
          });

          let lastProgress = 0;
          command
            .on("progress", (progress) => {
              const currentSeconds = progress.timemark
                .split(":")
                .reduce((acc, time) => acc * 60 + parseFloat(time), 0);
              const percent = Math.min(
                100,
                Math.round((currentSeconds / totalDuration) * 100)
              );
              if (percent > lastProgress) {
                lastProgress = percent;
                logger.info(`[${jobId}] FFmpeg progress`, {
                  percent,
                  timemark: progress.timemark,
                });
                progressEmitter?.emit("progress", {
                  ...progress,
                  percent,
                  totalDuration,
                  currentSeconds,
                });
              }
            })
            .on("error", (err: FFmpegError) => {
              err.details = {
                input: validatedClips.map((clip) => clip.path),
                output: localOutput,
                filters: filterInfo,
              };
              err.cmd = fullCommand;
              logger.error(`[${jobId}] FFmpeg error:`, {
                error: err.message,
                code: err.code,
                exitCode: err.exitCode,
                commandLine: err.cmd,
              });
              reject(err);
            })
            .on("end", async () => {
              try {
                await this.validateFile(localOutput, "Output video");
                if (outputPath.startsWith("https://")) {
                  const s3Key = this.getS3KeyFromUrl(outputPath);
                  await this.uploadToS3(localOutput, s3Key);
                }
                logger.info(
                  `[${jobId}] Video stitching completed successfully`,
                  {
                    outputPath,
                    durationMs: Date.now() - startTime,
                    clipCount: validatedClips.length,
                  }
                );

                // Cleanup all temp files
                for (const file of tempFiles) {
                  await fs.unlink(file).catch((err) =>
                    logger.warn(`[${jobId}] Failed to cleanup temp file`, {
                      file,
                      error: err.message,
                    })
                  );
                }
                resolve();
              } catch (error) {
                reject(error);
              }
            });

          await Promise.race([
            new Promise<void>((resolvePromise) => {
              command.save(localOutput).on("end", () => resolvePromise());
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("FFmpeg processing timeout after 30s")),
                30000
              )
            ),
          ]);
        } catch (error) {
          logger.error(`[${jobId}] Video stitching failed`, {
            outputPath,
            error: error instanceof Error ? error.message : "Unknown error",
            durationMs: Date.now() - startTime,
          });
          reject(error);
        }
      };

      setupCommand();
    });
  }

  private async getAvailableCodec(): Promise<string> {
    return new Promise((resolve) => {
      exec("ffmpeg -encoders", (error, stdout) => {
        if (error) {
          logger.warn(
            "Failed to check FFmpeg encoders, defaulting to libx264",
            { error }
          );
          resolve("libx264");
          return;
        }

        logger.info("Available FFmpeg encoders:", {
          hasLibx264: stdout.includes("libx264"),
          hasNvenc: stdout.includes("h264_nvenc"),
          hasVideotoolbox: stdout.includes("h264_videotoolbox"),
        });

        // First try to detect hardware encoders
        if (stdout.includes("h264_nvenc")) {
          try {
            // Test if NVENC is actually working by running a simple command with verbose output
            exec(
              "ffmpeg -v verbose -f lavfi -i color=c=black:s=32x32 -t 1 -c:v h264_nvenc -f null -",
              (nvencError, nvencStdout, nvencStderr) => {
                if (!nvencError) {
                  logger.info("Using NVENC hardware acceleration");
                  resolve("h264_nvenc");
                } else {
                  logger.warn(
                    "NVENC detected but not working, falling back to libx264",
                    {
                      error: nvencError.message,
                      stderr: nvencStderr,
                    }
                  );
                  resolve("libx264");
                }
              }
            );
          } catch (testError) {
            logger.warn("Failed to test NVENC, falling back to libx264", {
              error:
                testError instanceof Error
                  ? testError.message
                  : "Unknown error",
            });
            resolve("libx264");
          }
        } else if (stdout.includes("h264_videotoolbox")) {
          try {
            // Test if VideoToolbox is actually working with verbose output
            exec(
              "ffmpeg -v verbose -f lavfi -i color=c=black:s=32x32 -t 1 -c:v h264_videotoolbox -f null -",
              (vtError, vtStdout, vtStderr) => {
                if (!vtError) {
                  logger.info("Using VideoToolbox hardware acceleration");
                  resolve("h264_videotoolbox");
                } else {
                  logger.warn(
                    "VideoToolbox detected but not working, falling back to libx264",
                    {
                      error: vtError.message,
                      stderr: vtStderr,
                    }
                  );
                  resolve("libx264");
                }
              }
            );
          } catch (testError) {
            logger.warn(
              "Failed to test VideoToolbox, falling back to libx264",
              {
                error:
                  testError instanceof Error
                    ? testError.message
                    : "Unknown error",
              }
            );
            resolve("libx264");
          }
        } else {
          // No hardware acceleration available
          logger.info(
            "No hardware acceleration available, using software encoding with libx264"
          );
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
            await this.stitchVideos(clips, outputFile, {
              music: options.music,
            } as VideoTemplate);
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
      await this.stitchVideos(finalClips, outputPath, {
        music: options.music,
      } as VideoTemplate);

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
    await this.stitchVideos(clips, outputPath, {
      music: template,
    } as VideoTemplate);
  }

  async processClips(
    clips: VideoClip[],
    outputPath: string,
    template?: ReelTemplate
  ): Promise<void> {
    await this.createVideoFromClips(clips, outputPath, template);
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
}

export const videoProcessingService = VideoProcessingService.getInstance();
