import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

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

  public parseUrl(url: string): S3ParsedUrl {
    let bucket: string;
    let key: string;

    if (url.startsWith("s3://")) {
      // Handle s3:// protocol
      const [, , bucketPart, ...keyParts] = url.split("/");
      bucket = bucketPart;
      key = keyParts.join("/");
    } else {
      // Handle https:// protocol
      const urlObj = new URL(url);
      bucket = urlObj.hostname.split(".")[0];
      key = decodeURIComponent(urlObj.pathname.substring(1));
    }

    // Remove any query parameters from the key
    key = key.split("?")[0];

    if (!bucket || !key) {
      throw new Error(`Invalid S3 URL format: bucket=${bucket}, key=${key}`);
    }

    return { bucket, key, originalUrl: url };
  }

  public async downloadFile(url: string): Promise<Buffer> {
    try {
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
      throw new Error(
        `Failed to download from S3: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  public async uploadFile(
    buffer: Buffer,
    key: string,
    contentType?: string
  ): Promise<string> {
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
      return `s3://${bucket}/${key}`;
    } catch (error) {
      console.error("S3 upload error:", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(
        `Failed to upload to S3: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}

// Export singleton instance
export const s3Service = new S3Service();
