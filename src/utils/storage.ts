import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StoragePathParams } from "../config/storage.js";
import { s3Client, AWS_CONFIG } from "../config/s3.js";

export const generateStoragePath = (
  pathTemplate: string,
  params: StoragePathParams
): string => {
  let path = pathTemplate;
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      path = path.replace(`{${key}}`, value);
    }
  });
  return path;
};

export const generatePresignedUploadUrl = async (
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<string> => {
  const command = new PutObjectCommand({
    Bucket: AWS_CONFIG.bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

export const generatePresignedDownloadUrl = async (
  key: string,
  expiresIn = 3600
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: AWS_CONFIG.bucket,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

export const deleteFile = async (key: string): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: AWS_CONFIG.bucket,
    Key: key,
  });

  await s3Client.send(command);
};

export const sanitizeFilename = (filename: string): string => {
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-+/g, "-");
};

export const getFileExtension = (filename: string): string => {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()?.toLowerCase() || "" : "";
};

export const generateUniqueFilename = (
  originalFilename: string,
  prefix?: string
): string => {
  const timestamp = Date.now();
  const sanitized = sanitizeFilename(originalFilename);
  const parts = sanitized.split(".");
  const extension = parts.pop() || "";
  const basename = parts.join(".");

  return `${prefix || ""}${basename}-${timestamp}.${extension}`;
};
