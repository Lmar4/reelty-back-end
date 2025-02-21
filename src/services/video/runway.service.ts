import RunwayML from "@runwayml/sdk";
import { tempFileManager } from "../storage/temp-file.service";
import { s3Service } from "../storage/s3.service";
import { imageProcessor } from "../imageProcessing/image.service";
import * as fs from "fs/promises";
import { logger } from "../../utils/logger";

// Our custom constraints on the SDK types
type RunwayModel = "gen3a_turbo";
type RunwayRatio = "768:1280";
type RunwayDuration = 5 | 10;

interface ImageToVideoCreateParams {
  model: RunwayModel;
  promptImage: string;
  promptText: string;
  duration: RunwayDuration;
  ratio: RunwayRatio;
}

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

export class RunwayService {
  private static instance: RunwayService;
  private client: RunwayML;

  private constructor(apiKey: string) {
    if (!apiKey) throw new Error("RunwayML API key is required");
    this.client = new RunwayML({
      apiKey,
      maxRetries: RETRY_CONFIG.maxRetries,
      timeout: 60000, // 1 minute timeout
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
      if (status !== "SUCCEEDED") {
        throw new Error(`Video generation was ${status.toLowerCase()}`);
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

  private async pollTaskStatus(taskId: string): Promise<string> {
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes maximum (10 second intervals * 30)

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 10000));

      try {
        const task = await this.retryWithBackoff(
          () => this.client.tasks.retrieve(taskId),
          "Task status check"
        );
        attempts++;

        logger.info("Task status:", {
          taskId,
          status: task.status,
          attempt: attempts,
          maxAttempts,
        });

        switch (task.status) {
          case "FAILED":
            throw new Error(task.failure || "Video generation failed");
          case "CANCELLED":
            throw new Error("Video generation was cancelled");
          case "THROTTLED":
            throw new Error("Video generation was throttled");
          case "SUCCEEDED":
            return task.status;
        }
      } catch (error) {
        if (!this.isRetryableError(error)) {
          throw error;
        }
        // For retryable errors, continue polling
        logger.warn("Task status check failed, continuing polling:", {
          error: error instanceof Error ? error.message : "Unknown error",
          taskId,
          attempt: attempts,
        });
      }
    }

    throw new Error("Video generation timed out after 5 minutes");
  }

  private async downloadResult(
    taskId: string,
    index: number,
    listingId: string,
    jobId: string
  ): Promise<string> {
    const task = await this.client.tasks.retrieve(taskId);
    if (!task.output?.[0]) throw new Error("No video output URL found");

    const videoResponse = await fetch(task.output[0]);
    if (!videoResponse.ok)
      throw new Error(`Download failed: ${videoResponse.statusText}`);

    const tempFile = await tempFileManager.createTempPath(
      `segment_${index}.mp4`
    );
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    await tempFileManager.writeFile(tempFile, videoBuffer);

    const s3Key = `properties/${listingId}/videos/runway/${jobId}/segment_${index}.mp4`;
    await s3Service.uploadFile(videoBuffer, s3Key);
    logger.info("Video saved:", { taskId, localPath: tempFile.path, s3Key });

    return tempFile.path;
  }
}

export const runwayService = RunwayService.getInstance();
