import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  StoragePathParams,
  StoragePathSchema,
  STORAGE_BUCKET_NAME,
} from "../constants/storage";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

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
    Bucket: STORAGE_BUCKET_NAME,
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
    Bucket: STORAGE_BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

export const deleteFile = async (key: string): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: STORAGE_BUCKET_NAME,
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
  prefix = ""
): string => {
  const timestamp = Date.now();
  const sanitized = sanitizeFilename(originalFilename);
  const extension = getFileExtension(sanitized);
  const basename = sanitized.replace(`.${extension}`, "");

  return `${prefix}${basename}-${timestamp}.${extension}`;
};
