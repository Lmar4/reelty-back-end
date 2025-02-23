import { PutObjectCommand } from "@aws-sdk/client-s3";
import { AWS_CONFIG, s3Client } from "../../config/s3.js";
import {
  AllowedMimeType,
  AllowedMimeTypes,
  AssetType,
  FileType,
  StoragePathSchema,
} from "../../config/storage.js";
import {
  deleteFile,
  generatePresignedDownloadUrl,
  generatePresignedUploadUrl,
  generateStoragePath,
  generateUniqueFilename,
} from "../../utils/storage.js";

export class StorageService {
  private static instance: StorageService;

  private constructor() {}

  public static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  async uploadPropertyMedia(
    propertyId: string,
    file: {
      name: string;
      type: FileType;
      contentType: AllowedMimeType;
      buffer?: Buffer;
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    console.log("[STORAGE_SERVICE] Starting upload process:", {
      propertyId,
      fileType: file.type,
      contentType: file.contentType,
      bucket: AWS_CONFIG.bucket,
      hasBuffer: !!file.buffer,
      region: AWS_CONFIG.region,
      hasCredentials: !!AWS_CONFIG.credentials.accessKeyId,
    });

    // Validate mime type matches the file type
    const validMimeTypes = AllowedMimeTypes[file.type];
    const isValidMimeType = (validMimeTypes as readonly string[]).includes(
      file.contentType
    );
    if (!isValidMimeType) {
      throw new Error(`Unsupported file type: ${file.contentType}`);
    }

    // Generate unique filename and path
    const filename = generateUniqueFilename(file.name);
    const fileKey = generateStoragePath(StoragePathSchema.PROPERTY.PHOTOS, {
      propertyId,
      filename,
    });

    console.log("[STORAGE_SERVICE] Attempting S3 operation:", {
      fileKey,
      bucket: AWS_CONFIG.bucket,
      operation: file.buffer ? "PutObject" : "GeneratePresignedUrl",
    });

    if (file.buffer) {
      try {
        // If we have a buffer, upload directly
        const command = new PutObjectCommand({
          Bucket: AWS_CONFIG.bucket,
          Key: fileKey,
          Body: file.buffer,
          ContentType: file.contentType,
        });
        console.log("[STORAGE_SERVICE] PutObject command created:", {
          bucket: command.input.Bucket,
          key: command.input.Key,
          hasBody: !!command.input.Body,
          contentType: command.input.ContentType,
        });

        await s3Client.send(command);
        // Get a download URL for the uploaded file
        const uploadUrl = await generatePresignedDownloadUrl(fileKey);
        return { uploadUrl, fileKey };
      } catch (error) {
        console.error("[STORAGE_SERVICE] S3 upload error:", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
          bucket: AWS_CONFIG.bucket,
          key: fileKey,
        });
        throw error;
      }
    } else {
      // Otherwise, generate a presigned URL for client-side upload
      const uploadUrl = await generatePresignedUploadUrl(
        fileKey,
        file.contentType
      );
      return { uploadUrl, fileKey };
    }
  }

  async uploadUserDocument(
    userId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.document)[number];
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const filename = generateUniqueFilename(file.name);
    const fileKey = `${generateStoragePath(StoragePathSchema.USER.DOCUMENTS, {
      userId,
    })}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async uploadUserProfile(
    userId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const filename = generateUniqueFilename(file.name, "profile-");
    const fileKey = `${generateStoragePath(StoragePathSchema.USER.PROFILE, {
      userId,
    })}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async uploadOrganizationLogo(
    orgId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const filename = generateUniqueFilename(file.name, "logo-");
    const fileKey = `${generateStoragePath(
      StoragePathSchema.ORGANIZATION.LOGO,
      { orgId }
    )}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async getDownloadUrl(fileKey: string): Promise<string> {
    return generatePresignedDownloadUrl(fileKey);
  }

  async deleteFile(fileKey: string): Promise<void> {
    return deleteFile(fileKey);
  }

  async uploadAsset(file: {
    name: string;
    type: AssetType;
    contentType: AllowedMimeType;
  }): Promise<{ uploadUrl: string; fileKey: string }> {
    // Validate mime type matches the file type
    const validMimeTypes = AllowedMimeTypes[file.type];
    const isValidMimeType = (validMimeTypes as readonly string[]).includes(
      file.contentType
    );
    if (!isValidMimeType) {
      throw new Error(`Unsupported file type: ${file.contentType}`);
    }

    // Generate unique filename and path
    const filename = generateUniqueFilename(file.name);
    let pathTemplate: string;

    switch (file.type) {
      case "MUSIC":
        pathTemplate = StoragePathSchema.ASSETS.MUSIC;
        break;
      case "WATERMARK":
        pathTemplate = StoragePathSchema.ASSETS.WATERMARK;
        break;
      case "LOTTIE":
        pathTemplate = StoragePathSchema.ASSETS.LOTTIE;
        break;
      default:
        throw new Error(`Unsupported asset type: ${file.type}`);
    }

    const fileKey = `${pathTemplate}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }
}
