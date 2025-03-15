import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AllowedMimeTypes } from "../config/storage.js";

interface UploadMediaOptions {
  name: string;
  type: "image" | "video" | "document";
  contentType:
    | (typeof AllowedMimeTypes.image)[number]
    | (typeof AllowedMimeTypes.video)[number]
    | (typeof AllowedMimeTypes.document)[number];
  buffer?: Buffer;
}

export class StorageService {
  private static instance: StorageService;
  private s3Client: S3Client;
  private bucket: string;

  private constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
    this.bucket = process.env.AWS_BUCKET || "";
  }

  public static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  private generatePropertyMediaKey(
    propertyId: string,
    options: UploadMediaOptions
  ): string {
    const timestamp = Date.now();
    const sanitizedName = options.name
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, "-");
    return `properties/${propertyId}/${options.type}s/${timestamp}-${sanitizedName}`;
  }

  async uploadPropertyMedia(
    propertyId: string,
    options: UploadMediaOptions
  ): Promise<{ fileKey: string; uploadUrl: string }> {
    const fileKey = this.generatePropertyMediaKey(propertyId, options);

    if (options.buffer) {
      // Direct upload using buffer
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: fileKey,
          Body: options.buffer,
          ContentType: options.contentType,
        })
      );
    }

    const uploadUrl = await this.getSignedUrl(fileKey);
    return { fileKey, uploadUrl };
  }

  async getSignedUrl(fileKey: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
  }

  async deleteFile(fileKey: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: fileKey,
      })
    );
  }
}
