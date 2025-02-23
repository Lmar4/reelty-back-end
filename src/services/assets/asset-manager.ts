import { AssetType, PrismaClient } from "@prisma/client";
import * as crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { logger } from "../../utils/logger.js";
import { S3VideoService } from "../video/s3-video.service.js";
import { AssetCacheService } from "../cache/asset-cache.service.js";
import { TemplateKey } from "../imageProcessing/templates/types.js";
import { videoProcessingService } from "../video/video-processing.service.js";
import {
  TemplateAssetType,
  TemplateAssetMetadata,
  SharedAssets,
  AssetValidationResult,
} from "./types.js";

interface CachedAsset {
  path: string;
  expiresAt: Date;
}

interface AssetMetadata {
  expiresAt: string;
  localPath?: string;
}

interface FallbackAsset {
  s3Key: string;
  type: AssetType;
}

export class AssetManager {
  private static instance: AssetManager;
  private readonly bucket: string;
  private readonly region: string;
  private readonly prisma: PrismaClient;
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly assetPaths: Map<AssetType, string>;
  private readonly s3AssetPaths: Map<AssetType, string>;
  private readonly s3VideoService: S3VideoService;
  private readonly fallbackAssets: Map<AssetType, FallbackAsset>;
  private readonly templateAssetPaths = new Map<TemplateAssetType, string>([
    ["runway", "temp/templates/runway"],
    ["map", "temp/templates/map"],
    ["watermark", "temp/templates/watermark"],
    ["music", "temp/templates/music"],
  ]);
  private readonly assetCacheService: AssetCacheService;

  private constructor() {
    this.prisma = new PrismaClient();
    this.bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    this.region = process.env.AWS_REGION || "us-east-2";
    this.assetPaths = new Map([
      [AssetType.MUSIC, path.join(process.cwd(), "temp", "assets", "music")],
      [
        AssetType.WATERMARK,
        path.join(process.cwd(), "temp", "assets", "watermark"),
      ],
      [AssetType.LOTTIE, path.join(process.cwd(), "temp", "assets", "lottie")],
    ]);
    this.s3AssetPaths = new Map([
      [AssetType.MUSIC, "assets/music"],
      [AssetType.WATERMARK, "assets/watermark"],
      [AssetType.LOTTIE, "assets/lottie"],
    ]);
    this.s3VideoService = S3VideoService.getInstance();

    // Initialize fallback assets
    this.fallbackAssets = new Map([
      [
        AssetType.WATERMARK,
        {
          s3Key: "assets/watermark/default_watermark.png",
          type: AssetType.WATERMARK,
        },
      ],
      [
        AssetType.MUSIC,
        { s3Key: "assets/music/default_background.mp3", type: AssetType.MUSIC },
      ],
    ]);
    this.assetCacheService = AssetCacheService.getInstance();
  }

  public static getInstance(): AssetManager {
    if (!AssetManager.instance) {
      AssetManager.instance = new AssetManager();
    }
    return AssetManager.instance;
  }

  private generateHash(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(`${filePath}${Date.now()}`);
    return hash.digest("hex");
  }

  private async verifyS3Asset(s3Key: string): Promise<boolean> {
    try {
      return await this.s3VideoService.checkFileExists(this.bucket, s3Key);
    } catch (error) {
      logger.warn("Failed to verify S3 asset:", {
        s3Key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  private async getFallbackAsset(type: AssetType): Promise<string | null> {
    const fallback = this.fallbackAssets.get(type);
    if (!fallback) {
      return null;
    }

    try {
      const exists = await this.verifyS3Asset(fallback.s3Key);
      if (!exists) {
        logger.error("Fallback asset not found:", {
          type,
          s3Key: fallback.s3Key,
        });
        return null;
      }

      const s3Url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${fallback.s3Key}`;
      logger.info("Using fallback asset:", {
        type,
        s3Key: fallback.s3Key,
        s3Url,
      });
      return s3Url;
    } catch (error) {
      logger.error("Failed to get fallback asset:", {
        type,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  public async getAssetPath(
    type: AssetType,
    name: string,
    forceDownload: boolean = false
  ): Promise<string> {
    try {
      const cacheKey = `${type}/${name}`;
      const s3BasePath = this.s3AssetPaths.get(type);
      if (!s3BasePath) {
        throw new Error(`Invalid asset type: ${type}`);
      }

      // Generate S3 URL
      const s3Key = `${s3BasePath}/${name}`;
      const s3Url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;

      // Verify the asset exists in S3
      const exists = await this.verifyS3Asset(s3Key);
      if (!exists) {
        logger.warn("Primary asset not found, attempting fallback:", {
          type,
          name,
          s3Key,
        });

        const fallbackUrl = await this.getFallbackAsset(type);
        if (!fallbackUrl) {
          throw new Error(`No fallback available for asset type: ${type}`);
        }
        return fallbackUrl;
      }

      logger.info("Asset resolved via AssetManager", {
        type,
        name,
        s3Url,
      });

      return s3Url;
    } catch (error) {
      logger.error("Failed to get asset path", {
        type,
        name,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  public async ensureFallbackAssetsExist(): Promise<void> {
    for (const [type, fallback] of this.fallbackAssets) {
      try {
        const exists = await this.verifyS3Asset(fallback.s3Key);
        if (!exists) {
          logger.error("Critical fallback asset missing:", {
            type,
            s3Key: fallback.s3Key,
          });
          // You might want to trigger an alert or notification here
        }
      } catch (error) {
        logger.error("Failed to verify fallback asset:", {
          type,
          s3Key: fallback.s3Key,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  async cleanup(): Promise<void> {
    try {
      const expiredAssets = await this.prisma.processedAsset.findMany({
        where: {
          type: "asset",
          metadata: {
            not: {
              equals: null,
            },
          },
        },
      });

      for (const asset of expiredAssets) {
        const metadata = asset.metadata as unknown as AssetMetadata;
        if (new Date(metadata.expiresAt) < new Date() && metadata.localPath) {
          try {
            await fs.unlink(metadata.localPath);
            await this.prisma.processedAsset.delete({
              where: { id: asset.id },
            });
          } catch (error) {
            logger.error("Failed to cleanup asset", {
              assetId: asset.id,
              path: metadata.localPath,
              error,
            });
          }
        }
      }
    } catch (error) {
      logger.error("Failed to run asset cleanup", { error });
    }
  }

  public async listAssets(type: AssetType): Promise<string[]> {
    const basePath = this.assetPaths.get(type);
    if (!basePath) {
      throw new Error(`Invalid asset type: ${type}`);
    }

    try {
      const files = await fs.readdir(basePath);
      return files;
    } catch (error) {
      logger.error(`Failed to list assets of type ${type}:`, error);
      return [];
    }
  }

  public async addAsset(
    type: AssetType,
    name: string,
    sourcePath: string
  ): Promise<void> {
    const basePath = this.assetPaths.get(type);
    if (!basePath) {
      throw new Error(`Invalid asset type: ${type}`);
    }

    const targetPath = path.join(basePath, name);
    try {
      await fs.copyFile(sourcePath, targetPath);
      logger.info(`Added ${type} asset: ${name}`);
    } catch (error) {
      logger.error(`Failed to add ${type} asset ${name}:`, error);
      throw error;
    }
  }

  public async removeAsset(type: AssetType, name: string): Promise<void> {
    const basePath = this.assetPaths.get(type);
    if (!basePath) {
      throw new Error(`Invalid asset type: ${type}`);
    }

    const assetPath = path.join(basePath, name);
    try {
      await fs.unlink(assetPath);
      logger.info(`Removed ${type} asset: ${name}`);
    } catch (error) {
      logger.error(`Failed to remove ${type} asset ${name}:`, error);
      throw error;
    }
  }

  public async getHealth(): Promise<Record<string, any>> {
    const health: Record<string, any> = {};

    for (const [type, path] of this.assetPaths.entries()) {
      try {
        const stats = await fs.stat(path);
        const files = await fs.readdir(path);
        health[type] = {
          exists: true,
          path,
          isDirectory: stats.isDirectory(),
          fileCount: files.length,
        };
      } catch (error) {
        health[type] = {
          exists: false,
          path,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }

    return health;
  }

  private async validateAsset(
    type: TemplateAssetType,
    filePath: string
  ): Promise<AssetValidationResult> {
    try {
      switch (type) {
        case "runway":
        case "map":
          const duration = await videoProcessingService.getVideoDuration(
            filePath
          );
          if (duration <= 0) {
            return {
              isValid: false,
              error: `Invalid video duration: ${duration}`,
              duration,
            };
          }
          return { isValid: true, duration };

        case "music":
          const audioValid = await videoProcessingService.validateMusicFile(
            filePath
          );
          if (!audioValid) {
            return {
              isValid: false,
              error: "Invalid music file",
            };
          }
          return { isValid: true };

        case "watermark":
          // Validate image format and dimensions
          const stats = await fs.stat(filePath);
          if (stats.size === 0) {
            return {
              isValid: false,
              error: "Empty watermark file",
            };
          }
          // Could add more image validation here
          return { isValid: true };

        default:
          return {
            isValid: false,
            error: `Unknown asset type: ${type}`,
          };
      }
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getTemplateAsset(
    type: TemplateAssetType,
    metadata: TemplateAssetMetadata
  ): Promise<string | null> {
    const lockKey = `${type}_${metadata.jobId}_${metadata.listingId || ""}_${
      metadata.index || ""
    }`;

    try {
      // First try cache
      const cached = await this.assetCacheService.getCachedTemplateAsset(
        type,
        metadata
      );
      if (cached) {
        // Validate cached asset
        const validation = await this.validateAsset(type, cached);
        if (validation.isValid) {
          logger.debug("Template asset found in cache and validated", {
            type,
            jobId: metadata.jobId,
            path: cached,
            validation,
          });
          return cached;
        } else {
          logger.warn("Cached asset failed validation, will re-download", {
            type,
            jobId: metadata.jobId,
            path: cached,
            error: validation.error,
          });
        }
      }

      // Get base path for this asset type
      const basePath = this.templateAssetPaths.get(type);
      if (!basePath) {
        throw new Error(`Invalid template asset type: ${type}`);
      }

      // Create unique filename
      const filename = this.generateTemplateAssetFilename(type, metadata);
      const localPath = path.join(process.cwd(), basePath, filename);

      // Ensure directory exists
      await fs.mkdir(path.dirname(localPath), { recursive: true });

      // Download the asset
      if (!metadata.originalPath) {
        throw new Error("originalPath required for asset download");
      }
      await this.s3VideoService.downloadVideo(metadata.originalPath, localPath);

      // Validate downloaded asset
      const validation = await this.validateAsset(type, localPath);
      if (!validation.isValid) {
        throw new Error(`Asset validation failed: ${validation.error}`);
      }

      // Cache the validated asset
      await this.assetCacheService.cacheTemplateAsset(localPath, {
        type,
        metadata,
        settings: { validation },
      });

      logger.info("Template asset downloaded, validated and cached", {
        type,
        jobId: metadata.jobId,
        path: localPath,
        validation,
      });

      return localPath;
    } catch (error) {
      logger.error("Failed to get template asset", {
        type,
        jobId: metadata.jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  private generateTemplateAssetFilename(
    type: TemplateAssetType,
    metadata: TemplateAssetMetadata
  ): string {
    const { jobId, templateKey, index } = metadata;
    switch (type) {
      case "runway":
        return `runway_${jobId}_${index}.mp4`;
      case "map":
        return `map_${jobId}.mp4`;
      case "watermark":
        return `watermark_${jobId}.png`;
      case "music":
        return `music_${templateKey}_${jobId}.mp3`;
      default:
        throw new Error(`Invalid template asset type: ${type}`);
    }
  }
}

// New SharedAssetsManager class
export class SharedAssetsManager {
  private static instance: SharedAssetsManager;
  private readonly assetManager: AssetManager;
  private readonly assetCacheService: AssetCacheService;

  private constructor() {
    this.assetManager = AssetManager.getInstance();
    this.assetCacheService = AssetCacheService.getInstance();
  }

  public static getInstance(): SharedAssetsManager {
    if (!SharedAssetsManager.instance) {
      SharedAssetsManager.instance = new SharedAssetsManager();
    }
    return SharedAssetsManager.instance;
  }

  async prepareSharedAssets(
    jobId: string,
    runwayVideos: string[],
    templates: TemplateKey[],
    mapVideo?: string
  ): Promise<SharedAssets> {
    const assets: SharedAssets = {
      runwayVideos: new Map(),
      music: new Map(),
    };

    try {
      // Download and cache runway videos
      await Promise.all(
        runwayVideos.map(async (video, index) => {
          const local = await this.assetManager.getTemplateAsset("runway", {
            jobId,
            index,
            originalPath: video,
          });
          if (local) assets.runwayVideos.set(video, local);
        })
      );

      // Handle map video if present
      if (mapVideo) {
        const mapAsset = await this.assetManager.getTemplateAsset("map", {
          jobId,
          originalPath: mapVideo,
        });
        assets.mapVideo = mapAsset || undefined;
      }

      // Get shared watermark
      const watermarkAsset = await this.assetManager.getTemplateAsset(
        "watermark",
        {
          jobId,
        }
      );
      assets.watermark = watermarkAsset || undefined;

      // Get music for each template
      await Promise.all(
        templates.map(async (template) => {
          const music = await this.assetManager.getTemplateAsset("music", {
            jobId,
            templateKey: template,
          });
          if (music) assets.music.set(template, music);
        })
      );

      logger.info("Shared assets prepared successfully", {
        jobId,
        runwayCount: assets.runwayVideos.size,
        hasMap: !!assets.mapVideo,
        hasWatermark: !!assets.watermark,
        musicCount: assets.music.size,
      });

      return assets;
    } catch (error) {
      logger.error("Failed to prepare shared assets", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  async cleanup(jobId: string): Promise<void> {
    try {
      await this.assetCacheService.cleanupTemplateAssets(jobId);
      logger.info("Cleaned up shared assets", { jobId });
    } catch (error) {
      logger.error("Failed to cleanup shared assets", {
        jobId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

export const sharedAssetsManager = SharedAssetsManager.getInstance();
export const assetManager = AssetManager.getInstance();
