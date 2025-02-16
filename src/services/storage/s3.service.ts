import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { rateLimiter } from "./rate-limiter";

const MAX_RETRIES = 5;
const BASE_DELAY = 1000; // 1 second

export interface S3ParsedUrl {
  bucket: string;
  key: string;
  originalUrl: string;
}

export class S3Service {
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
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

  public async downloadFile(url: string): Promise<Buffer> {
    return this.retryWithBackoff(async () => {
      try {
        // If the URL contains X-Amz-Signature, it's a pre-signed URL
        if (url.includes("X-Amz-")) {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return Buffer.from(await response.arrayBuffer());
        }

        // Otherwise, use GetObjectCommand for direct S3 paths
        const { bucket, key } = this.parseUrl(url);
        console.log("Downloading from S3:", { bucket, key });

        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });

        const response = await this.s3Client.send(command);

        if (!response.Body) {
          throw new Error("No response body from S3");
        }

        const chunks: Uint8Array[] = [];
        const stream = response.Body as Readable;

        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);

        if (buffer.length === 0) {
          throw new Error("Downloaded buffer is empty");
        }

        return buffer;
      } catch (error) {
        console.error("S3 download error:", {
          url,
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    });
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
}

// Export singleton instance
export const s3Service = new S3Service();
