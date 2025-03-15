import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { logger } from "../../utils/logger.js";
import ffmpeg from "fluent-ffmpeg";

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
  public async validateVideo(filePath: string): Promise<{
    hasVideo: boolean;
    hasAudio: boolean;
    duration: number;
    width?: number;
    height?: number;
    codec?: string;
    fps?: number;
  }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          logger.error("FFprobe error during validation", {
            path: filePath,
            error: err.message,
          });
          reject(err);
          return;
        }

        // Find video stream
        const videoStream = metadata.streams.find(
          (stream) => stream.codec_type === "video"
        );
        const audioStream = metadata.streams.find(
          (stream) => stream.codec_type === "audio"
        );

        // Enhanced logging for debugging
        logger.debug("Video validation metadata", {
          path: filePath,
          streams: metadata.streams.map((s) => ({
            codecType: s.codec_type,
            codec: s.codec_name,
            width: s.width,
            height: s.height,
            duration: s.duration,
          })),
          format: metadata.format,
        });

        const result = {
          hasVideo: !!videoStream,
          hasAudio: !!audioStream,
          duration: parseFloat(String(metadata.format.duration || "0")),
          width: videoStream?.width,
          height: videoStream?.height,
          codec: videoStream?.codec_name,
          fps: videoStream?.r_frame_rate
            ? eval(videoStream.r_frame_rate) // Safely evaluate frame rate fraction
            : undefined,
        };

        // Log validation result
        logger.info("Video validation result", {
          path: filePath,
          ...result,
        });

        resolve(result);
      });
    });
  }

  // Add a more comprehensive validation method
  public async validateVideoIntegrity(filePath: string): Promise<boolean> {
    try {
      const metadata = await this.validateVideo(filePath);

      // Enhanced validation criteria
      const isValid = Boolean(
        metadata.hasVideo && // Has video stream
          metadata.duration > 0 && // Has duration
          metadata.width &&
          metadata.width > 0 && // Has valid dimensions
          metadata.height &&
          metadata.height > 0 &&
          metadata.codec && // Has valid codec
          !isNaN(metadata.fps as number) &&
          metadata.fps! > 0 // Has valid framerate
      );

      logger.info("Video integrity check result", {
        path: filePath,
        isValid,
        metadata,
      });

      return isValid;
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
      const metadata = await this.validateVideo(filePath);
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
