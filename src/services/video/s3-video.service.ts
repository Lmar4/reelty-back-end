import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import "dotenv/config";
import * as fs from "fs";
import { Readable } from "stream";
import { logger } from "../../utils/logger.js";
import * as path from "path";
import { promises as fsPromises } from "fs";
import { VideoValidationService } from "./video-validation.service.js";

export class S3VideoService {
  private static instance: S3VideoService;
  private s3Client: S3Client;

  private constructor() {
    // Initialize S3 client with credentials from environment variables
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  public static getInstance(): S3VideoService {
    if (!S3VideoService.instance) {
      S3VideoService.instance = new S3VideoService();
    }
    return S3VideoService.instance;
  }

  public parseS3Path(s3Path: string): { bucket: string; key: string } {
    try {
      // Handle s3:// protocol
      if (s3Path.startsWith("s3://")) {
        const parts = s3Path.substring(5).split("/");
        const bucket = parts[0];
        const key = parts.slice(1).join("/");
        return { bucket, key };
      }

      // Handle https:// protocol
      if (s3Path.startsWith("http")) {
        const url = new URL(s3Path);
        const hostParts = url.hostname.split(".");

        // Extract bucket from hostname (bucket.s3.region.amazonaws.com)
        const bucket = hostParts[0];

        // Remove leading slash from pathname
        const key = url.pathname.startsWith("/")
          ? url.pathname.substring(1)
          : url.pathname;

        return { bucket, key };
      }

      // Handle direct path format (no protocol)
      const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
      const key = s3Path.startsWith("/") ? s3Path.substring(1) : s3Path;

      return { bucket, key };
    } catch (error) {
      console.error(`Failed to parse S3 path: ${s3Path}`, error);
      throw new Error(`Invalid URL: ${s3Path}`);
    }
  }

  public getPublicUrl(key: string, bucket?: string): string {
    const bucketName =
      bucket || process.env.AWS_BUCKET || "reelty-prod-storage";
    const region = process.env.AWS_REGION || "us-east-2";

    // Ensure the key doesn't start with a slash
    const sanitizedKey = key.startsWith("/") ? key.substring(1) : key;

    return `https://${bucketName}.s3.${region}.amazonaws.com/${sanitizedKey}`;
  }

  public async uploadVideo(
    localPath: string,
    s3Path: string,
    options?: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<string> {
    try {
      const sanitizedPath = s3Path.startsWith("/")
        ? s3Path.substring(1)
        : s3Path;
      const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";

      const fileStream = fs.createReadStream(localPath);
      fileStream.on("error", (err) => {
        logger.error("File stream error", { localPath, error: err.message });
      });

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucketName,
          Key: sanitizedPath,
          Body: fileStream,
          ContentType: options?.contentType || "video/mp4",
          Metadata: options?.metadata,
        },
      });

      await upload.done();
      const url = this.getPublicUrl(sanitizedPath);
      logger.info("Video uploaded successfully", { localPath, s3Path, url });
      return url;
    } catch (error) {
      logger.error("S3 video upload failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        localPath,
        s3Path,
      });
      throw error; // Don’t wrap as "Invalid URL"
    }
  }

  public async downloadVideo(s3Path: string, localPath: string): Promise<void> {
    try {
      const { bucket, key } = this.parseS3Path(s3Path);

      // Ensure the directory exists
      const dir = path.dirname(localPath);
      await fsPromises.mkdir(dir, { recursive: true });

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error("Empty response body from S3");
      }

      // Use streams for better memory handling
      const writeStream = fs.createWriteStream(localPath);
      const body = response.Body;
      if (!body || !(body instanceof Readable)) {
        throw new Error("Invalid response body from S3");
      }

      await new Promise<void>((resolve, reject) => {
        body
          .pipe(writeStream)
          .on("finish", () => resolve())
          .on("error", reject);
      });

      // Validate the downloaded file
      const stats = await fsPromises.stat(localPath);
      if (stats.size === 0) {
        throw new Error("Downloaded file is empty");
      }

      logger.info("File downloaded from S3", {
        localPath,
        url: s3Path,
        size: stats.size,
      });
    } catch (error) {
      logger.error("Failed to download file from S3:", {
        s3Path,
        localPath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  public async checkFileExists(bucket: string, key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if ((error as any)?.name === "NotFound") {
        return false;
      }
      throw error;
    }
  }

  public async uploadFile(fileBuffer: Buffer, s3Key: string): Promise<string> {
    try {
      const bucketName = process.env.AWS_BUCKET;

      if (!bucketName) {
        throw new Error("AWS_BUCKET environment variable is not set");
      }

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucketName,
          Key: s3Key,
          Body: fileBuffer,
          ContentType: "image/jpeg", // For thumbnails
        },
      });

      await upload.done();
      logger.info("File uploaded successfully", { s3Key });

      return this.getPublicUrl(s3Key, bucketName);
    } catch (error) {
      logger.error("S3 file upload failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Key,
      });
      throw error;
    }
  }

  public async getPresignedUrl(s3Key: string): Promise<string> {
    try {
      const bucketName = process.env.AWS_BUCKET;
      if (!bucketName) {
        throw new Error("AWS_BUCKET environment variable is not set");
      }

      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      });

      return getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    } catch (error) {
      logger.error("Failed to generate pre-signed URL:", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Key,
      });
      throw error;
    }
  }

  private async getObjectEtag(
    bucket: string,
    key: string
  ): Promise<string | null> {
    try {
      const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
      const response = await this.s3Client.send(command);
      return response.ETag ? response.ETag.replace(/"/g, "") : null; // Handle undefined case
    } catch (error) {
      if ((error as any)?.name === "NotFound") return null;
      throw error;
    }
  }

  private async downloadFileToStream(key: string): Promise<Readable> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await this.s3Client.send(command);
    return response.Body as Readable;
  }

  public async moveFromTempToListing(
    sourceKey: string,
    listingId: string,
    jobId: string
  ): Promise<string> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const destKey = `properties/${listingId}/videos/maps/${jobId}.mp4`;

    logger.info(`[${jobId}] Starting S3 move from ${sourceKey} to ${destKey}`);

    try {
      // First verify source exists and get its metadata
      const sourceHead = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: sourceKey })
      );
      const sourceEtag = sourceHead.ETag?.replace(/"/g, "") || null;
      if (!sourceEtag || !sourceHead.ContentLength) {
        throw new Error(`Source file not found or empty: ${sourceKey}`);
      }

      // Attempt to copy the file
      const copyCommand = new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceKey}`,
        Key: destKey,
      });

      await this.s3Client.send(copyCommand);

      // Verify copy success with retries
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 1000;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const destHead = await this.s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: destKey })
        );

        if (destHead.ContentLength === sourceHead.ContentLength) {
          // Clean up the temp file only after successful copy verification
          await this.s3Client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey })
          );

          const finalUrl = this.getPublicUrl(destKey, bucket);
          logger.info(`[${jobId}] Successfully moved and verified file`, {
            sourceKey,
            destKey,
            finalUrl,
            contentLength: destHead.ContentLength,
          });

          return finalUrl;
        }

        if (attempt < MAX_RETRIES - 1) {
          logger.warn(`[${jobId}] Size mismatch, retrying verification`, {
            attempt: attempt + 1,
            sourceSize: sourceHead.ContentLength,
            destSize: destHead.ContentLength,
          });
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        }
      }

      throw new Error("Failed to verify copied file integrity after retries");
    } catch (error) {
      logger.error(`[${jobId}] Failed to move S3 file`, {
        error: error instanceof Error ? error.message : "Unknown error",
        sourceKey,
        destKey,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  public async deleteFile(bucket: string, key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      logger.info("S3 file deleted successfully", { bucket, key });
    } catch (error) {
      logger.error("Failed to delete S3 file", {
        error: error instanceof Error ? error.message : "Unknown error",
        bucket,
        key,
      });
      throw error;
    }
  }

  /**
   * Downloads a video with retries and validation
   */
  async downloadVideoWithValidation(
    s3Url: string,
    localPath: string,
    jobId?: string
  ): Promise<boolean> {
    const MAX_RETRIES = parseInt(process.env.FILE_DOWNLOAD_RETRIES || "3", 10);
    const logContext = jobId ? `[${jobId}]` : "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Download the file
        await this.downloadVideo(s3Url, localPath);

        // Validate the downloaded file
        await VideoValidationService.getInstance().validateVideo(localPath);

        logger.info(
          `${logContext} Successfully downloaded and validated video`,
          {
            s3Url,
            localPath,
            attempt,
          }
        );

        return true;
      } catch (error) {
        logger.warn(
          `${logContext} Download attempt ${attempt}/${MAX_RETRIES} failed`,
          {
            s3Url,
            localPath,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        );

        if (attempt === MAX_RETRIES) {
          logger.error(`${logContext} All download attempts failed`, {
            s3Url,
            localPath,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return false;
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random()),
          30000
        );
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Clean up any partial download
        try {
          await fsPromises.unlink(localPath);
        } catch (cleanupError) {
          // Ignore errors if file doesn't exist
        }
      }
    }

    return false;
  }

  /**
   * Verifies a file exists in S3 with retries
   */
  async verifyS3FileWithRetries(
    bucket: string,
    key: string,
    retries = 3
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const exists = await this.checkFileExists(bucket, key);
        if (exists) return true;

        if (attempt < retries) {
          // Exponential backoff with jitter
          const delay = Math.min(
            1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random()),
            10000
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        logger.warn(`S3 verification attempt ${attempt}/${retries} failed`, {
          bucket,
          key,
          error: error instanceof Error ? error.message : "Unknown error",
        });

        if (attempt < retries) {
          // Exponential backoff with jitter
          const delay = Math.min(
            1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random()),
            10000
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return false;
  }
}

// Export singleton instance
export const s3VideoService = S3VideoService.getInstance();
