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
import { logger } from "../../utils/logger";

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
  ): Promise<void> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    const destKey = `properties/${listingId}/videos/maps/${jobId}.mp4`;

    logger.info(`[${jobId}] Starting S3 move from ${sourceKey} to ${destKey}`);

    try {
      // First verify source exists and get its ETag
      const sourceEtag = await this.getObjectEtag(bucket, sourceKey);
      if (!sourceEtag) {
        throw new Error(`Source file not found: ${sourceKey}`);
      }

      // Attempt to copy the file
      const copyCommand = new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceKey}`,
        Key: destKey,
      });

      const response = await this.s3Client.send(copyCommand);
      const destEtag = response.CopyObjectResult?.ETag?.replace(/"/g, "");

      // Check if ETags match (ignoring multipart upload indicators)
      const sourceEtagBase = sourceEtag.split("-")[0];
      const destEtagBase = destEtag ? destEtag.split("-")[0] : null;

      if (!destEtag || sourceEtagBase !== destEtagBase) {
        logger.warn(`[${jobId}] ETag mismatch detected, re-uploading`, {
          sourceEtag,
          destEtag,
          sourceKey,
          destKey,
        });

        // Re-upload the file directly to the destination
        const fileStream = await this.downloadFileToStream(sourceKey);
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: bucket,
            Key: destKey,
            Body: fileStream,
            ContentType: "video/mp4",
          },
        });

        await upload.done();

        // Verify the re-upload
        const newDestEtag = await this.getObjectEtag(bucket, destKey);
        if (!newDestEtag) {
          throw new Error(`Re-uploaded file not found: ${destKey}`);
        }

        // For multipart uploads, we can't compare ETags directly
        // Instead, verify the file exists and has content
        const verifyCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: destKey,
        });
        const verifyResponse = await this.s3Client.send(verifyCommand);
        if (
          !verifyResponse.ContentLength ||
          verifyResponse.ContentLength === 0
        ) {
          throw new Error(`Re-uploaded file is empty: ${destKey}`);
        }

        logger.info(`[${jobId}] Re-upload successful`, {
          destKey,
          contentLength: verifyResponse.ContentLength,
        });
      }

      // Clean up the temp file only after successful copy/upload
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey })
      );
      logger.info(`[${jobId}] Successfully moved file to ${destKey}`);
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
}

// Export singleton instance
export const s3VideoService = S3VideoService.getInstance();
