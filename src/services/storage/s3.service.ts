import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { rateLimiter } from "./rate-limiter";
import { createReadStream } from "fs";
import { logger } from "../../utils/logger";
import * as fs from "fs";
import { parse as parseUrl } from "url";
import { Upload } from "@aws-sdk/lib-storage";

const MAX_RETRIES = 5;
const BASE_DELAY = 1000; // 1 second

export interface S3ParsedUrl {
  bucket: string;
  key: string;
  originalUrl: string;
}

if (!process.env.AWS_REGION) {
  throw new Error("AWS_REGION environment variable is not set");
}

// Set AWS_BUCKET with fallback value
process.env.AWS_BUCKET = process.env.AWS_BUCKET || "reelty-prod-storage";

export class S3Service {
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION as string,
    });
    this.bucket = process.env.AWS_S3_BUCKET as string;
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    retries: number = MAX_RETRIES
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await rateLimiter.schedule(operation);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if we should retry based on the error
        if (
          error instanceof Error &&
          (error.message.includes("SlowDown") ||
            error.message.includes("TooManyRequests") ||
            error.message.includes("RequestLimitExceeded"))
        ) {
          const delay = Math.min(
            BASE_DELAY * Math.pow(2, attempt),
            30000 // Max 30 seconds
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw lastError;
      }
    }

    throw lastError;
  }

  private cleanUrl(url: string): string {
    // Remove query parameters from URL
    return url.split("?")[0];
  }

  public parseUrl(url: string): S3ParsedUrl {
    // Clean the URL first
    const cleanUrl = this.cleanUrl(url);
    let bucket: string;
    let key: string;

    if (cleanUrl.startsWith("s3://")) {
      // Handle s3:// protocol
      const [, , bucketPart, ...keyParts] = cleanUrl.split("/");
      bucket = bucketPart;
      key = keyParts.join("/");
    } else {
      // Handle https:// protocol
      const urlObj = new URL(cleanUrl);
      bucket = urlObj.hostname.split(".")[0];
      key = decodeURIComponent(urlObj.pathname.substring(1));
    }

    if (!bucket || !key) {
      throw new Error(`Invalid S3 URL format: bucket=${bucket}, key=${key}`);
    }

    return { bucket, key, originalUrl: url };
  }

  public getKeyFromUrl(url: string): string | null {
    try {
      if (url.startsWith("s3://")) {
        return url.replace("s3://", "");
      }

      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/");
      return pathParts.slice(1).join("/");
    } catch (error) {
      logger.error("Failed to parse S3 URL:", error);
      return null;
    }
  }

  public async deleteFile(s3Key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
        })
      );
    } catch (error) {
      logger.error("Failed to delete S3 file:", error);
      throw error;
    }
  }

  public async downloadFile(url: string, localPath: string): Promise<void> {
    try {
      const { bucket, key } = this.parseUrl(url); // Use parseUrl
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      if (!response.Body) {
        throw new Error("Empty response from S3");
      }
      const writeStream = fs.createWriteStream(localPath);
      await new Promise<void>((resolve, reject) => {
        if (response.Body instanceof Readable) {
          response.Body.pipe(writeStream)
            .on("finish", () => resolve())
            .on("error", (err: Error) => reject(err));
        } else {
          reject(new Error("Response body is not a readable stream"));
        }
      });
      logger.info("File downloaded from S3", { url, localPath });
    } catch (error) {
      logger.error("Failed to download file from S3:", { error, url });
      throw error;
    }
  }

  public getCleanS3Path(key: string): string {
    const bucket = process.env.AWS_BUCKET;
    if (!bucket) {
      throw new Error("AWS_BUCKET environment variable is not set");
    }
    return `${key}`; // Just store the key, not the full s3:// URL
  }

  public getPublicUrl(key: string, bucket?: string): string {
    const bucketName =
      bucket || process.env.AWS_BUCKET || "reelty-prod-storage";
    if (!bucketName) {
      throw new Error(
        "AWS_BUCKET environment variable is not set and no bucket name provided"
      );
    }
    return `https://${bucketName}.s3.${
      process.env.AWS_REGION || "us-east-2"
    }.amazonaws.com/${key}`;
  }

  public async uploadFile(
    buffer: Buffer,
    key: string,
    contentType?: string
  ): Promise<string> {
    return this.retryWithBackoff(async () => {
      try {
        const bucket = process.env.AWS_BUCKET;
        if (!bucket) {
          throw new Error("AWS_BUCKET environment variable is not set");
        }

        const command = new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        });

        await this.s3Client.send(command);
        return this.getCleanS3Path(key); // Return clean path instead of s3:// URL
      } catch (error) {
        console.error("S3 upload error:", {
          key,
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    });
  }

  parseS3Url(url: string): { bucket: string; key: string } {
    const parsed = parseUrl(url);
    const pathComponents = parsed.pathname?.split("/") || [];

    // Remove empty first element if path starts with /
    if (pathComponents[0] === "") {
      pathComponents.shift();
    }

    return {
      bucket: parsed.hostname?.split(".")[0] || this.bucket,
      key: pathComponents.join("/"),
    };
  }

  async uploadVideo(localPath: string, s3Key: string): Promise<string> {
    return this.retryWithBackoff(async () => {
      try {
        const fileStream = fs.createReadStream(localPath);
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.bucket,
            Key: s3Key,
            Body: fileStream,
            ContentType: "video/mp4",
          },
        });

        await upload.done();
        return this.getPublicUrl(s3Key);
      } catch (error) {
        logger.error("Failed to upload video", {
          localPath,
          s3Key,
          error,
        });
        throw error;
      }
    });
  }

  // Standardize path generation
  getVideoPath(listingId: string, filename: string): string {
    return `properties/${listingId}/videos/${filename}`;
  }

  getRunwayVideoPath(listingId: string, filename: string): string {
    return `properties/${listingId}/videos/runway/${filename}`;
  }

  getListingImagePath(listingId: string, filename: string): string {
    return `users/${listingId}/listings/${filename}`;
  }

  getListingVideoPath(
    listingId: string,
    jobId: string,
    filename: string
  ): string {
    return `users/${listingId}/videos/runway/${jobId}/${filename}`;
  }

  getProcessedImagePath(listingId: string, filename: string): string {
    return `properties/${listingId}/images/processed/${filename}`;
  }

  // Add a method to get the existing path
  getExistingPath(url: string): string {
    const parsed = this.parseS3Url(url);
    return parsed.key;
  }
}

// Export singleton instance
export const s3Service = new S3Service();

export async function uploadToS3(
  filePath: string,
  s3Key: string,
  contentType?: string
): Promise<string> {
  try {
    const fileStream = createReadStream(filePath);
    const buffer = await streamToBuffer(fileStream);
    await s3Service.uploadFile(buffer, s3Key, contentType);

    // Return the S3 URL
    return `https://${process.env.AWS_BUCKET}.s3.${
      process.env.AWS_REGION || "us-east-1"
    }.amazonaws.com/${s3Key}`;
  } catch (error) {
    logger.error("Error uploading to S3:", error);
    throw error;
  }
}

// Helper function to convert stream to buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
