import { VideoGenerationStatus } from "@prisma/client";

export type ProcessingStatus = VideoGenerationStatus;

export interface Asset {
  id: string;
  url: string;
  type: "image" | "video";
  processed?: boolean;
  error?: string;
}

export interface JobStatus {
  jobId: string;
  status: ProcessingStatus;
  progress: number;
  assets: Asset[];
  error?: string;
}

export interface TemplateConfig {
  id: string;
  name: string;
  description: string;
  thumbnailUrl?: string;
  requiredAssets: string[];
  defaultAssets?: Record<string, string>;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

export interface ProcessingResult {
  success: boolean;
  url?: string;
  error?: string;
}

export type CacheKey = string;
export type ProcessingPromise<T> = Promise<T>;
