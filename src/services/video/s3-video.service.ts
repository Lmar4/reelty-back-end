import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "fs";

export class S3VideoService {
  private static instance: S3VideoService;
  private s3Client: S3Client;

  private constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
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

  public getPublicUrl(bucket: string, key: string): string {
    return `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }

  public async uploadVideo(localPath: string, s3Path: string): Promise<string> {
    try {
      const fileContent = await fs.promises.readFile(localPath);
      const { bucket, key } = this.parseS3Path(s3Path);

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileContent,
        ContentType: "video/mp4",
      });

      await this.s3Client.send(command);
      return this.getPublicUrl(bucket, key);
    } catch (error) {
      console.error("S3 video upload failed:", {
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
}

// Export singleton instance
export const s3VideoService = S3VideoService.getInstance();
