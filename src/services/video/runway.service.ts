import RunwayML from "@runwayml/sdk";
import { tempFileManager } from "../storage/temp-file.service";
import { s3Service } from "../storage/s3.service";
import { imageProcessor } from "../imageProcessing/image.service";
import * as fs from "fs/promises";
import { logger } from "../../utils/logger";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "stream";

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  retryableStatuses: [429, 502, 503, 504],
};

interface RunwayError {
  status?: number;
  message?: string;
}

type TaskStatus =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "PENDING"
  | "CANCELLED"
  | "TIMEOUT"
  | "THROTTLED"; // Add THROTTLED status

interface TaskStatusResponse {
  status: TaskStatus;
  error?: string;
  progress?: number;
  failure?: string; // Add failure field
}

export class RunwayService {
  private static instance: RunwayService;
  private client: RunwayML;
  private s3Client: S3Client;

  private constructor(apiKey: string) {
    if (!apiKey) throw new Error("RunwayML API key is required");
    this.client = new RunwayML({
      apiKey,
      maxRetries: RETRY_CONFIG.maxRetries,
      timeout: 60000, // 1 minute timeout
    });

    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  public static getInstance(
    apiKey: string = process.env.RUNWAYML_API_KEY || ""
  ): RunwayService {
    if (!RunwayService.instance) {
      RunwayService.instance = new RunwayService(apiKey);
    }
    return RunwayService.instance;
  }

  private calculateBackoff(attempt: number): number {
    // Exponential backoff with jitter
    const exponentialDelay = Math.min(
      RETRY_CONFIG.maxDelay,
      RETRY_CONFIG.baseDelay * Math.pow(2, attempt)
    );
    // Add jitter (random delay up to 50% of the calculated delay)
    const jitter = Math.random() * 0.5 * exponentialDelay;
    return exponentialDelay + jitter;
  }

  private isRetryableError(error: RunwayError | unknown): boolean {
    if (error && typeof error === "object" && "status" in error) {
      return RETRY_CONFIG.retryableStatuses.includes(error.status as number);
    }
    return false;
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    let attempt = 0;

    while (attempt < RETRY_CONFIG.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempt++;
        const runwayError = error as RunwayError;

        if (
          !this.isRetryableError(runwayError) ||
          attempt === RETRY_CONFIG.maxRetries
        ) {
          logger.error(`${context} failed permanently:`, {
            error: error instanceof Error ? error.message : "Unknown error",
            status: runwayError.status,
            attempt,
          });
          throw error;
        }

        const backoffTime = this.calculateBackoff(attempt);
        logger.warn(`${context} failed, retrying in ${backoffTime}ms:`, {
          error: error instanceof Error ? error.message : "Unknown error",
          status: runwayError.status,
          attempt,
          nextAttemptIn: backoffTime,
        });

        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      }
    }

    throw new Error(
      `${context} failed after ${RETRY_CONFIG.maxRetries} retries`
    );
  }

  public async generateVideo(
    imageUrl: string,
    index: number,
    listingId: string,
    jobId: string
  ): Promise<string> {
    try {
      // Create task with retry
      const taskId = await this.retryWithBackoff(
        () => this.createTask(imageUrl, index),
        "Task creation"
      );
      logger.info("Task created on Runway:", { taskId, listingId, jobId });

      // Poll for completion
      const status = await this.pollTaskStatus(taskId);
      if (status.status !== "SUCCEEDED") {
        throw new Error(`Video generation was ${status.status.toLowerCase()}`);
      }

      // Download result with retry
      const localPath = await this.retryWithBackoff(
        () => this.downloadResult(taskId, index, listingId, jobId),
        "Result download"
      );

      return localPath;
    } catch (error) {
      if (error instanceof RunwayML.APIError) {
        switch (error.status) {
          case 400:
            throw new Error(`Invalid input: ${error.message}`);
          case 401:
            throw new Error("Invalid API key");
          case 404:
            throw new Error("Resource not found");
          case 429:
            throw new Error("Rate limit exceeded");
          default:
            throw new Error(`Runway API error: ${error.message}`);
        }
      }
      throw error;
    }
  }

  private async createTask(imageUrl: string, index: number): Promise<string> {
    logger.info("Starting video generation:", { imageUrl, index });

    try {
      let imageBuffer: Buffer;

      if (imageUrl.includes("X-Amz-") || imageUrl.startsWith("s3://")) {
        // Handle pre-signed URL or direct S3 URL
        const tempPath = await tempFileManager.createTempPath("image.jpg");
        await s3Service.downloadFile(imageUrl, tempPath.path);
        imageBuffer = await fs.readFile(tempPath.path);
      } else {
        // Handle regular HTTPS URL
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to download image: ${response.statusText}`);
        }
        imageBuffer = Buffer.from(await response.arrayBuffer());
      }

      const dataUrl = await imageProcessor.bufferToDataUrl(imageBuffer);

      const imageToVideo = await this.client.imageToVideo.create({
        model: "gen3a_turbo",
        promptImage: dataUrl,
        promptText: "Move forward slowly",
        duration: 5,
        ratio: "768:1280",
      });

      if (!imageToVideo?.id) throw new Error("No task ID received");
      return imageToVideo.id;
    } catch (error) {
      if (error instanceof RunwayML.APIError) {
        logger.error("Task creation failed:", {
          status: error.status,
          message: error.message,
          imageUrl,
          index,
        });
      }
      throw error;
    }
  }

  private async pollTaskStatus(taskId: string): Promise<TaskStatusResponse> {
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes maximum (10 second intervals * 30)
    const NON_RETRYABLE_STATUSES = [400, 401, 403, 404];
    const REQUEST_TIMEOUT = 30000; // 30 seconds per request timeout

    const checkTaskWithTimeout = async (): Promise<TaskStatusResponse> => {
      return Promise.race([
        this.retryWithBackoff(
          () => this.client.tasks.retrieve(taskId),
          "Task status check"
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timeout")),
            REQUEST_TIMEOUT
          )
        ),
      ]);
    };

    while (attempts < maxAttempts) {
      try {
        // Wait 10 seconds between checks with timeout
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, 10000)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Poll interval timeout")), 15000)
          ),
        ]);

        const task = await checkTaskWithTimeout();
        attempts++;

        logger.info("Task status:", {
          taskId,
          status: task.status,
          attempt: attempts,
          maxAttempts,
        });

        const status = task.status as TaskStatus;

        if (status === "SUCCEEDED") {
          return { status, progress: 100 };
        }

        if (status === "FAILED" || status === "CANCELLED") {
          return {
            status,
            error: task.failure || `Task ${status}`,
            progress: 0,
          };
        }

        if (status === "TIMEOUT") {
          logger.error("Task timed out:", {
            taskId,
            attempt: attempts,
          });
          throw new Error("Video generation timed out");
        }

        if (status === "RUNNING") {
          logger.info("Task in progress:", {
            taskId,
            status: task.status,
            attempt: attempts,
          });
        }
      } catch (error) {
        const runwayError = error as RunwayError;
        const isTimeout =
          error instanceof Error &&
          (error.message === "Request timeout" ||
            error.message === "Poll interval timeout");

        // Handle timeouts specially
        if (isTimeout) {
          logger.warn("Timeout during status check:", {
            taskId,
            attempt: attempts,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          continue; // Skip to next attempt
        }

        // Check for non-retryable errors
        if (
          runwayError.status &&
          NON_RETRYABLE_STATUSES.includes(runwayError.status)
        ) {
          logger.error("Non-retryable error encountered:", {
            taskId,
            status: runwayError.status,
            message: runwayError.message,
            attempt: attempts,
          });
          throw new Error(
            `Non-retryable error: ${runwayError.message || "Unknown error"}`
          );
        }

        // For retryable errors, check if we should continue
        if (!this.isRetryableError(error) || attempts >= maxAttempts) {
          logger.error("Max retries reached or non-retryable error:", {
            taskId,
            error: error instanceof Error ? error.message : "Unknown error",
            attempt: attempts,
            maxAttempts,
          });
          throw error;
        }

        // Calculate backoff for retryable errors
        const backoffTime = this.calculateBackoff(attempts);
        logger.warn("Retryable error encountered, retrying:", {
          taskId,
          error: error instanceof Error ? error.message : "Unknown error",
          attempt: attempts,
          nextAttemptIn: backoffTime,
        });

        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      }
    }

    const timeoutError = new Error(
      "Video generation timed out after 5 minutes"
    );
    logger.error("Task timeout:", {
      taskId,
      attempts,
      maxAttempts,
    });
    throw timeoutError;
  }

  private async downloadResult(
    taskId: string,
    index: number,
    listingId: string,
    jobId: string
  ): Promise<string> {
    const task = await this.client.tasks.retrieve(taskId);
    if (!Array.isArray(task.output) || task.output.length === 0) {
      throw new Error("No valid video output from Runway");
    }

    const videoResponse = await fetch(task.output[0]);
    if (!videoResponse.ok)
      throw new Error(`Download failed: ${videoResponse.statusText}`);

    const s3Key = `properties/${listingId}/videos/runway/${jobId}/segment_${index}.mp4`;
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";

    // Create a readable stream from the response body
    const stream = Readable.from(videoResponse.body as ReadableStream);
    let upload: Upload | undefined;

    try {
      // Upload directly to S3 using multipart upload
      upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucket,
          Key: s3Key,
          Body: stream,
          ContentType: "video/mp4",
        },
      });

      await upload.done();

      const s3Url = `https://${bucket}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${s3Key}`;
      logger.info("Video uploaded to S3:", { taskId, s3Key, s3Url });

      return s3Url;
    } catch (error) {
      logger.error("Failed to upload video to S3:", {
        error: error instanceof Error ? error.message : "Unknown error",
        taskId,
        s3Key,
      });

      // Attempt to abort the upload if it exists
      if (upload) {
        try {
          await upload.abort();
          logger.info("Aborted failed upload:", { taskId, s3Key });
        } catch (abortError) {
          logger.warn("Failed to abort upload:", {
            error:
              abortError instanceof Error
                ? abortError.message
                : "Unknown error",
            taskId,
            s3Key,
          });
        }
      }

      throw error;
    } finally {
      // Cleanup stream
      stream.destroy();
    }
  }
}

export const runwayService = RunwayService.getInstance();
