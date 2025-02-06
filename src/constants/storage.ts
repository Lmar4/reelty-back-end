import { z } from "zod";

export const STORAGE_BUCKET_NAME =
  process.env.STORAGE_BUCKET_NAME || "reelty-storage";

export const StoragePathSchema = {
  USER: {
    PROFILE: "users/{userId}/profile",
    DOCUMENTS: "users/{userId}/documents",
  },
  PROPERTY: {
    PHOTOS: "properties/{propertyId}/photos",
    VIDEOS: "properties/{propertyId}/videos",
    DOCUMENTS: "properties/{propertyId}/documents",
    VIRTUAL_TOURS: "properties/{propertyId}/virtual-tours",
  },
  ORGANIZATION: {
    LOGO: "organizations/{orgId}/logo",
    DOCUMENTS: "organizations/{orgId}/documents",
  },
  ASSETS: {
    MUSIC: "assets/music",
    WATERMARK: "assets/watermark",
    LOTTIE: "assets/lottie",
  },
} as const;

export const FileTypeSchema = z.enum(["image", "video", "document"]);
export type FileType = z.infer<typeof FileTypeSchema>;

export const AssetTypeSchema = z.enum(["MUSIC", "WATERMARK", "LOTTIE"]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const StoragePathParamsSchema = z.object({
  userId: z.string().optional(),
  propertyId: z.string().optional(),
  orgId: z.string().optional(),
  filename: z.string().optional(),
});

export type StoragePathParams = z.infer<typeof StoragePathParamsSchema>;

export const AllowedMimeTypes = {
  image: ["image/jpeg", "image/png", "image/webp"] as const,
  video: ["video/mp4", "video/webm"] as const,
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ] as const,
  MUSIC: ["audio/mpeg", "audio/wav", "audio/ogg"] as const,
  WATERMARK: ["image/png", "image/webp"] as const,
  LOTTIE: ["application/json"] as const,
} as const;

export type AllowedMimeType =
  (typeof AllowedMimeTypes)[keyof typeof AllowedMimeTypes][number];

export const MaxFileSizes = {
  image: 5 * 1024 * 1024, // 5MB
  video: 100 * 1024 * 1024, // 100MB
  document: 10 * 1024 * 1024, // 10MB
} as const;
