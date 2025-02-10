import { z } from "zod";

// Storage path templates
export const StoragePathSchema = {
  PROPERTY: {
    PHOTOS: "properties/{propertyId}/photos",
  },
  USER: {
    DOCUMENTS: "users/{userId}/documents",
    PROFILE: "users/{userId}/profile",
  },
  ORGANIZATION: {
    LOGO: "organizations/{orgId}/logo",
  },
  ASSETS: {
    MUSIC: "assets/music",
    WATERMARK: "assets/watermark",
    LOTTIE: "assets/lottie",
  },
} as const;

// File types
export const FileTypeSchema = z.enum([
  "image",
  "video",
  "document",
  "MUSIC",
  "WATERMARK",
  "LOTTIE",
]);
export type FileType = z.infer<typeof FileTypeSchema>;

// Asset types
export const AssetTypeSchema = z.enum(["MUSIC", "WATERMARK", "LOTTIE"]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AllowedMimeTypes = {
  image: ["image/jpeg", "image/png", "image/webp"] as const,
  video: ["video/mp4", "video/webm"] as const,
  document: ["application/pdf"] as const,
  MUSIC: ["audio/mpeg", "audio/mp3", "audio/wav"] as const,
  WATERMARK: ["image/png", "image/webp"] as const,
  LOTTIE: ["application/json"] as const,
} as const;

export type AllowedMimeType =
  (typeof AllowedMimeTypes)[keyof typeof AllowedMimeTypes][number];

export type StoragePathParams = {
  propertyId?: string;
  userId?: string;
  orgId?: string;
  filename?: string;
};

// File size limits in bytes
export const MaxFileSizes = {
  image: 15 * 1024 * 1024, // 15MB
  video: 100 * 1024 * 1024, // 100MB
  document: 10 * 1024 * 1024, // 10MB
  MUSIC: 20 * 1024 * 1024, // 20MB
  WATERMARK: 5 * 1024 * 1024, // 5MB
  LOTTIE: 1 * 1024 * 1024, // 1MB
} as const;

export const STORAGE_BUCKET_NAME =
  process.env.AWS_S3_BUCKET || "reelty-storage";
