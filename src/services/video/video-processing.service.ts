import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import { createReadStream } from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import { S3Service } from "../storage/s3.service";
import { ReelTemplate } from "../imageProcessing/templates/types";
import {
  VideoTemplate,
  WatermarkConfig,
} from "../video/video-template.service";
import { exec } from "child_process";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import { EventEmitter } from "events";

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
  private readonly FFmpeg_TIMEOUT = 60 * 60 * 1000; // 1 hour timeout

  private constructor() {
    this.s3Service = new S3Service();
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
      await fs.access(filePath, fs.constants.R_OK);
      const stats = await fs.stat(filePath);
      if (stats.size === 0) {
        throw new Error(`${context} is empty`);
      }
      logger.debug(`Validated ${context} file`, { filePath, size: stats.size });
    } catch (error) {
      logger.error(`Failed to validate ${context} file`, {
        filePath,
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
      await this.s3Service.downloadFile(assetPath, localPath);
      logger.info(`Downloaded ${type} asset from S3`, { assetPath, localPath });
      return localPath;
    }
    try {
      await fs.access(assetPath, fs.constants.R_OK);
      logger.debug(`Local ${type} asset verified`, { assetPath });
      return assetPath;
    } catch (error) {
      if (isRequired) {
        logger.error(`Required ${type} asset not found`, { assetPath, error });
        throw new Error(`Required ${type} asset not found: ${assetPath}`);
      }
      logger.warn(`Optional ${type} asset not found, skipping`, { assetPath });
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

      // Apply color correction
      const colorOutput = `color${i}`;
      const filterOptions =
        clip.colorCorrection?.ffmpegFilter ||
        "contrast=0.9:brightness=0.05:saturation=0.95";
      filterCommands.push({
        filter: filterOptions.startsWith("eq=")
          ? filterOptions.substring(3)
          : "eq",
        options: filterOptions.startsWith("eq=")
          ? filterOptions.substring(3)
          : filterOptions,
        inputs: [`pts${i}`],
        outputs: [colorOutput],
      });

      // Handle transitions between clips
      if (i > 0 && clip.transition) {
        const { type, duration } = clip.transition;
        const transitionType = type === "slide" ? "crossfade" : type;
        filterCommands.push({
          filter: "xfade",
          options: `transition=${transitionType}:duration=${duration}`,
          inputs: [lastOutput, colorOutput],
          outputs: [`trans${i}`],
        });
        lastOutput = `trans${i}`;
      } else {
        lastOutput = colorOutput;
      }
    });

    // Concatenate all clips
    if (clips.length > 1) {
      const inputs = clips.map((_, i) =>
        i > 0 && clips[i].transition ? `trans${i}` : `color${i}`
      );
      filterCommands.push({
        filter: "concat",
        options: `n=${inputs.length}:v=1:a=0`,
        inputs,
        outputs: ["vconcat"],
      });
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
    return ffmpeg()
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
      });
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
    const details: Record<string, unknown> = {
      code: error.code,
      exitCode: error.exitCode,
      killed: error.killed,
      message: error.message,
    };
    if (error.ffmpegOutput) {
      details.ffmpegOutput = error.ffmpegOutput
        .split("\n")
        .filter((line) => line.toLowerCase().includes("error"));
    }

    logger.error(`[${context}] FFmpeg processing failed`, details);
    throw new Error(`FFmpeg error in ${context}: ${error.message}`);
  }

  private async uploadToS3(filePath: string, s3Key: string): Promise<string> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const region = process.env.AWS_REGION || "us-east-2";
    const MAX_RETRIES = 3;

    logger.info("Starting S3 upload", { filePath, s3Key });

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
        logger.info("S3 upload completed", { filePath, s3Key, s3Url, attempt });
        return s3Url;
      } catch (error) {
        logger.warn("S3 upload attempt failed", {
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

    // Validate and log detailed clip information
    const clipsWithDuration = await Promise.all(
      clips.map(async (clip, index) => {
        try {
          const resolvedPath = await this.resolveAssetPath(
            clip.path,
            "video",
            true
          );
          // Get video duration if not already set
          if (clip.duration == null) {
            const duration = await this.getVideoDuration(resolvedPath);
            clip.duration = duration;
          }

          logger.info(`Clip ${index} validation:`, {
            path: clip.path,
            resolvedPath,
            originalDuration: clip.duration,
            hasTransition: !!clip.transition,
            hasColorCorrection: !!clip.colorCorrection,
          });

          return clip;
        } catch (error) {
          logger.error(`Failed to process clip ${index}:`, {
            path: clip.path,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      })
    );

    // Calculate total duration including transitions
    const totalDuration = clipsWithDuration.reduce((sum, clip, index) => {
      if (!clip.duration) {
        throw new Error(`Clip ${index} has no duration: ${clip.path}`);
      }
      const transitionDuration =
        clip.transition && index < clips.length - 1
          ? clip.transition.duration
          : 0;
      return sum + clip.duration + transitionDuration;
    }, 0);

    logger.info("Starting video stitching", {
      clipCount: clipsWithDuration.length,
      totalDuration,
      outputPath,
      templateName: template.name,
      hasWatermark: !!watermarkConfig,
    });

    return new Promise((resolve, reject) => {
      const command = this.createFFmpegCommand();

      const setupCommand = async () => {
        try {
          await Promise.all(
            clipsWithDuration.map(async (clip, i) => {
              const resolvedPath = await this.resolveAssetPath(
                clip.path,
                "video",
                true
              );
              await this.validateFile(resolvedPath, `Clip ${i}`);
              command.input(resolvedPath);
            })
          );

          let musicIndex = -1;
          let musicPath = "";
          if (template?.music?.path) {
            musicPath = await this.resolveAssetPath(
              template.music.path,
              "music",
              true
            );
            musicIndex = clipsWithDuration.length;
            command.input(musicPath);
          }

          let watermarkIndex = -1;
          let watermarkPath = "";
          if (watermarkConfig) {
            watermarkPath = await this.resolveAssetPath(
              watermarkConfig.path,
              "watermark",
              true
            );
            watermarkIndex =
              musicIndex !== -1 ? musicIndex + 1 : clipsWithDuration.length;
            command
              .input(watermarkPath)
              .inputOptions(["-loop", "1", "-framerate", "24", "-f", "image2"]);
          }

          const filterGraph = this.buildFilterGraph(
            clipsWithDuration,
            watermarkConfig,
            musicIndex,
            watermarkIndex
          );
          if (filterGraph && filterGraph.length > 0) {
            command.complexFilter(filterGraph);
          } else {
            command.outputOptions([
              `-filter_complex`,
              `concat=n=${clipsWithDuration.length}:v=1:a=0[vout]`,
            ]);
          }

          const videoCodec = await this.getAvailableCodec();
          command
            .videoCodec(videoCodec)
            .audioCodec("aac")
            .outputOptions([
              "-map [vout]",
              ...(musicIndex !== -1 ? ["-map [aout]"] : []),
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

          command
            .on("progress", (progress) => {
              if (progressEmitter) {
                // Convert timemark (HH:MM:SS) to seconds
                const timeComponents = progress.timemark.split(":");
                const currentSeconds =
                  parseInt(timeComponents[0]) * 3600 +
                  parseInt(timeComponents[1]) * 60 +
                  parseFloat(timeComponents[2]);

                // Calculate actual percentage (cap at 100)
                const percent = Math.min(
                  100,
                  Math.round((currentSeconds / totalDuration) * 100)
                );

                progressEmitter.emit("progress", {
                  ...progress,
                  percent,
                  totalDuration,
                  currentSeconds,
                  estimatedTimeLeft: totalDuration - currentSeconds,
                });
              }
            })
            .on("error", (err) => {
              logger.error("FFmpeg error:", err);
              reject(err);
            })
            .on("end", async () => {
              try {
                await this.validateFile(localOutput, "Output video");
                if (outputPath.startsWith("https://")) {
                  const s3Key = this.getS3KeyFromUrl(outputPath);
                  await this.uploadToS3(localOutput, s3Key);
                  await fs.unlink(localOutput);
                  logger.info("Local file cleaned up after S3 upload", {
                    localOutput,
                  });
                }
                logger.info("Video stitching completed successfully", {
                  outputPath,
                  durationMs: Date.now() - startTime,
                  clipCount: clipsWithDuration.length,
                  hasMusic: musicIndex !== -1,
                  hasWatermark: watermarkIndex !== -1,
                });
                resolve();
              } catch (error) {
                reject(error);
              }
            });

          await Promise.race([
            new Promise<void>((resolve) => {
              command.save(localOutput).on("end", () => {
                resolve();
              });
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("FFmpeg processing timeout")),
                this.FFmpeg_TIMEOUT
              )
            ),
          ]);
        } catch (error) {
          logger.error("Video stitching failed", {
            outputPath,
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
            durationMs: Date.now() - startTime,
          });
          reject(error);
        }
      };

      // Execute the async setup function
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
        if (stdout.includes("h264_nvenc")) {
          logger.info("Using NVENC hardware acceleration");
          resolve("h264_nvenc");
        } else if (stdout.includes("h264_videotoolbox")) {
          logger.info("Using VideoToolbox hardware acceleration");
          resolve("h264_videotoolbox");
        } else {
          logger.info("Using software encoding with libx264");
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

  private async getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          logger.error("Failed to get video duration:", {
            path: filePath,
            error: err.message,
          });
          reject(err);
          return;
        }
        const duration = metadata.format.duration;
        if (!duration) {
          reject(new Error(`No duration found for video: ${filePath}`));
          return;
        }
        resolve(duration);
      });
    });
  }
}

export const videoProcessingService = VideoProcessingService.getInstance();
