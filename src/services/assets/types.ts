import type { Asset as PrismaAsset, AssetType } from "@prisma/client";
import { TemplateKey } from "../imageProcessing/templates/types";

export type { AssetType, PrismaAsset as Asset };

export interface GetAssetsParams {
  type?: AssetType;
  includeInactive?: boolean;
}

export interface CreateAssetInput {
  name: string;
  description?: string;
  type: AssetType;
  subscriptionTier: string;
  file: File;
}

export interface UpdateAssetInput {
  id: string;
  name?: string;
  description?: string;
  isActive?: boolean;
}

export interface AssetUploadResponse {
  id: string;
  filePath: string;
  uploadUrl: string;
}

export interface AssetDownloadResponse {
  downloadUrl: string;
  expiresAt: Date;
}

export interface AssetStats {
  totalAssets: number;
  byType: Record<AssetType, number>;
  byTier: Record<string, number>;
  activeAssets: number;
  totalStorage: number; // in bytes
}

// New template-specific types
export type TemplateAssetType = "runway" | "map" | "watermark" | "music";

export interface TemplateAssetMetadata {
  templateKey?: string;
  index?: number;
  jobId: string;
  originalPath?: string;
  listingId?: string;
}

export interface SharedAssets {
  runwayVideos: Map<string, string>; // original path -> local path
  mapVideo?: string;
  watermark?: string;
  music: Map<string, string>; // template -> local path
}

export interface TemplateAssetOptions {
  type: TemplateAssetType;
  metadata: TemplateAssetMetadata;
  ttl?: number;
  settings?: Record<string, any>;
}

export interface AssetValidationResult {
  isValid: boolean;
  duration?: number;
  error?: string;
  format?: string;
}
