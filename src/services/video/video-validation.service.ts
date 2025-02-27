import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { logger } from "../../utils/logger.js";

const execAsync = promisify(exec);

export interface VideoMetadata {
  duration: number;
  width?: number;
  height?: number;
  codec?: string;
  fps?: number;
  hasVideo: boolean;
  hasAudio?: boolean;
}

export class VideoValidationService {
  private static instance: VideoValidationService;
  private readonly MAX_RETRIES = parseInt(
    process.env.FILE_VALIDATION_RETRIES || "3",
    10
  );
  private readonly RETRY_DELAY = parseInt(
    process.env.FILE_VALIDATION_DELAY || "1000",
    10
  );
  private readonly VALIDATION_TIMEOUT = parseInt(
    process.env.FFMPEG_VALIDATION_TIMEOUT || "30000",
    10
  );
  private readonly TEMP_DIR = process.env.TEMP_DIR || "/app/temp";
  private readonly VALIDATION_DIR = path.join(this.TEMP_DIR, "validation");

  private constructor() {
    // Ensure validation directory exists
    fs.mkdir(this.VALIDATION_DIR, { recursive: true }).catch((err) => {
      logger.error("Failed to create validation directory", {
        error: err instanceof Error ? err.message : "Unknown error",
        path: this.VALIDATION_DIR,
      });
    });
  }

  public static getInstance(): VideoValidationService {
    if (!VideoValidationService.instance) {
      VideoValidationService.instance = new VideoValidationService();
    }
    return VideoValidationService.instance;
  }

  /**
   * Ensures a file is completely written and accessible before validation
   */
  private async ensureFileComplete(filePath: string): Promise<boolean> {
    try {
      // Check if file exists
      await fs.access(filePath);

      // Check if file size is stable (indicating it's fully written)
      const initialSize = (await fs.stat(filePath)).size;
      if (initialSize === 0) {
        logger.warn("File exists but is empty", { path: filePath });
        return false;
      }

      // Wait a short time and check if size changed
      await new Promise((resolve) => setTimeout(resolve, 500));
      const finalSize = (await fs.stat(filePath)).size;

      if (initialSize !== finalSize) {
        logger.info("File is still being written", {
          path: filePath,
          initialSize,
          finalSize,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.error("Error checking file completeness", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Creates a copy of the file for validation to prevent race conditions
   */
  private async createValidationCopy(filePath: string): Promise<string> {
    const validationPath = path.join(
      this.VALIDATION_DIR,
      `${path.basename(
        filePath,
        path.extname(filePath)
      )}_${Date.now()}${path.extname(filePath)}`
    );

    try {
      await fs.copyFile(filePath, validationPath);
      return validationPath;
    } catch (error) {
      logger.error("Failed to create validation copy", {
        sourcePath: filePath,
        targetPath: validationPath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Validates a video file with retries
   */
  public async validateVideo(
    filePath: string,
    jobId?: string
  ): Promise<VideoMetadata> {
    const logContext = jobId ? `[${jobId}]` : "";

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        // Check if file is completely written
        const isComplete = await this.ensureFileComplete(filePath);
        if (!isComplete) {
          logger.warn(`${logContext} File not completely written, retrying`, {
            path: filePath,
            attempt,
          });
          await new Promise((resolve) =>
            setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, attempt - 1))
          );
          continue;
        }

        // Create a copy for validation to prevent race conditions
        const validationCopy = await this.createValidationCopy(filePath);

        try {
          // Get video metadata
          const metadata = await this.getVideoMetadata(validationCopy);

          // Validate integrity
          const isValid = await this.validateVideoIntegrity(validationCopy);
          if (!isValid) {
            throw new Error("Video integrity check failed");
          }

          logger.info(`${logContext} Video validation successful`, {
            path: filePath,
            metadata,
            attempt,
          });

          return metadata;
        } finally {
          // Clean up validation copy
          await fs.unlink(validationCopy).catch((err) => {
            logger.warn(`${logContext} Failed to cleanup validation copy`, {
              path: validationCopy,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          });
        }
      } catch (error) {
        if (attempt === this.MAX_RETRIES) {
          logger.error(
            `${logContext} Video validation failed after ${this.MAX_RETRIES} attempts`,
            {
              path: filePath,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
          throw error;
        }

        logger.warn(
          `${logContext} Video validation attempt ${attempt} failed, retrying`,
          {
            path: filePath,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );

        await new Promise((resolve) =>
          setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, attempt - 1))
        );
      }
    }

    throw new Error(
      `Video validation failed after ${this.MAX_RETRIES} attempts`
    );
  }

  /**
   * Gets video metadata using ffprobe
   */
  private async getVideoMetadata(filePath: string): Promise<VideoMetadata> {
    try {
      const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
      const command = `${ffprobePath} -v error -show_entries format=duration -show_entries stream=width,height,codec_name,r_frame_rate -of json "${filePath}"`;

      const { stdout } = await execAsync(command, {
        timeout: this.VALIDATION_TIMEOUT,
      });
      const data = JSON.parse(stdout);

      const videoStream = data.streams.find(
        (s: any) => s.codec_type === "video"
      );
      const audioStream = data.streams.find(
        (s: any) => s.codec_type === "audio"
      );

      let fps = 0;
      if (videoStream && videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split("/");
        fps = parseInt(num, 10) / parseInt(den || "1", 10);
      }

      return {
        duration: parseFloat(data.format.duration || "0"),
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        fps,
        hasVideo: !!videoStream,
        hasAudio: !!audioStream,
      };
    } catch (error) {
      logger.error("Failed to get video metadata", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error(
        `Failed to get video metadata: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Validates video integrity by checking if it can be read completely
   */
  private async validateVideoIntegrity(filePath: string): Promise<boolean> {
    try {
      const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
      // Use a more thorough validation command
      const command = `${ffprobePath} -v error -show_entries stream=codec_type -select_streams v -of json -count_frames -count_packets "${filePath}"`;

      await execAsync(command, { timeout: this.VALIDATION_TIMEOUT });
      return true;
    } catch (error) {
      logger.error("Video integrity check failed", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Gets video duration
   */
  public async getVideoDuration(filePath: string): Promise<number> {
    try {
      const metadata = await this.getVideoMetadata(filePath);
      return metadata.duration;
    } catch (error) {
      logger.error("Failed to get video duration", {
        path: filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error(
        `Failed to get video duration: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}

export const videoValidationService = VideoValidationService.getInstance();
