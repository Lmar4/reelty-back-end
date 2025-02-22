import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";
import { logger } from "../../utils/logger";
import "dotenv/config";
import * as path from "path";

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
    // Handle s3:// protocol
    if (s3Path.startsWith("s3://")) {
      const [, , bucket, ...keyParts] = s3Path.split("/");
      return { bucket, key: keyParts.join("/") };
    }

    // Handle https:// protocol
    const url = new URL(s3Path);
    const bucket = url.hostname.split(".")[0];
    const key = decodeURIComponent(url.pathname.substring(1)); // Remove leading slash
    return { bucket, key: key.split("?")[0] }; // Remove query parameters
  }

  public getPublicUrl(key: string, bucket?: string): string {
    const region = process.env.AWS_REGION || "us-east-2";
    const bucketName =
      bucket || process.env.AWS_BUCKET || "reelty-prod-storage";
    if (!bucketName) {
      throw new Error(
        "AWS_BUCKET environment variable is not set and no bucket name provided"
      );
    }
    return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
  }

  public async uploadVideo(localPath: string, s3Path: string): Promise<string> {
    try {
      const fileStream = fs.createReadStream(localPath);
      const bucketName = process.env.AWS_BUCKET;

      if (!bucketName) {
        throw new Error("AWS_BUCKET environment variable is not set");
      }

      // Parse the S3 path to get the key
      const { key } = this.parseS3Path(s3Path);

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucketName,
          Key: key,
          Body: fileStream,
          ContentType: "video/mp4",
        },
      });

      await upload.done();
      logger.info("Video uploaded successfully", { localPath, s3Path });

      // Return public HTTPS URL instead of S3 protocol URL
      return this.getPublicUrl(key, bucketName);
    } catch (error) {
      logger.error("S3 video upload failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        localPath,
        s3Path,
      });
      throw error;
    }
  }

  public async downloadVideo(s3Path: string, localPath: string): Promise<void> {
    try {
      const { bucket, key } = this.parseS3Path(s3Path);
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      if (!response.Body) {
        throw new Error("No response body from S3");
      }

      const stream = response.Body as any;
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(localPath);
        stream.pipe(writeStream);
        writeStream.on("finish", () => resolve());
        writeStream.on("error", reject);
      });
    } catch (error) {
      console.error("S3 video download failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Path,
        localPath,
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

  public async moveFromTempToListing(
    tempKey: string,
    listingId: string,
    photoId: string
  ): Promise<{ originalUrl: string; webpUrl: string }> {
    const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
    if (!bucketName)
      throw new Error("AWS_BUCKET environment variable is not set");

    try {
      // If already in users/listings, no need to move—just return the URL
      if (tempKey.includes("/users/") && tempKey.includes("/listings/")) {
        const url = this.getPublicUrl(tempKey, bucketName);
        logger.info("[S3] Using existing file without move", { tempKey, url });
        return { originalUrl: url, webpUrl: url };
      }

      // For truly temporary files (not in users/listings), move as before
      const filename = path.basename(tempKey);
      const originalKey = `properties/${listingId}/images/processed/${filename}`; // Simplified path
      logger.info("[S3] Starting file move operation", {
        from: tempKey,
        to: originalKey,
        bucket: bucketName,
      });

      // First verify source exists
      const sourceExists = await this.checkFileExists(bucketName, tempKey);
      if (!sourceExists) {
        logger.error("[S3] Source file not found", { tempKey, bucketName });
        throw new Error(`Source file not found: ${tempKey}`);
      }

      // Get source file metadata for verification
      const sourceCommand = new HeadObjectCommand({
        Bucket: bucketName,
        Key: tempKey,
      });
      const sourceMetadata = await this.s3Client.send(sourceCommand);
      const sourceSize = sourceMetadata.ContentLength;
      const sourceETag = sourceMetadata.ETag;

      if (!sourceSize) {
        throw new Error("Source file is empty");
      }

      // Copy the file
      await this.s3Client.send(
        new CopyObjectCommand({
          Bucket: bucketName,
          CopySource: `/${bucketName}/${tempKey}`,
          Key: originalKey,
        })
      );

      // Verify the copy was successful
      const destCommand = new HeadObjectCommand({
        Bucket: bucketName,
        Key: originalKey,
      });

      try {
        const destMetadata = await this.s3Client.send(destCommand);
        const destSize = destMetadata.ContentLength;
        const destETag = destMetadata.ETag;

        if (!destSize || destSize !== sourceSize) {
          throw new Error(
            `Copy size mismatch: source=${sourceSize}, dest=${destSize}`
          );
        }

        if (destETag !== sourceETag) {
          throw new Error(
            `Copy ETag mismatch: source=${sourceETag}, dest=${destETag}`
          );
        }

        logger.info("[S3] Copy verified successfully", {
          tempKey,
          originalKey,
          size: destSize,
        });

        // Only delete source after successful verification
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: tempKey,
          })
        );

        const url = this.getPublicUrl(originalKey, bucketName);
        return { originalUrl: url, webpUrl: url };
      } catch (verifyError) {
        // If verification fails, try to clean up the destination
        try {
          await this.s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: originalKey,
            })
          );
        } catch (cleanupError) {
          logger.warn("[S3] Failed to cleanup failed copy", {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : "Unknown error",
            originalKey,
          });
        }
        throw verifyError;
      }
    } catch (error) {
      logger.error("[S3] Error moving files:", {
        error: error instanceof Error ? error.message : "Unknown error",
        tempKey,
        listingId,
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
}

// Export singleton instance
export const s3VideoService = S3VideoService.getInstance();
