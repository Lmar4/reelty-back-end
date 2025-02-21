import path from "path";
import fs from "fs/promises";
import { logger } from "../../utils/logger";
import { s3Service } from "../storage/s3.service";
import { PrismaClient } from "@prisma/client";

type AssetType = "music" | "watermark" | "overlay" | "template" | "lottie";

interface CachedAsset {
  localPath: string;
  expiresAt: Date;
}

class AssetManager {
  private static instance: AssetManager;
  private assetPaths: Map<AssetType, string>;
  private assetCache: Map<string, CachedAsset>;
  private initialized: boolean;
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly prisma: PrismaClient;
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.assetPaths = new Map();
    this.assetCache = new Map();
    this.initialized = false;
    this.prisma = new PrismaClient();
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupStaleAssets(), 60 * 60 * 1000); // Run every hour
  }

  public static getInstance(): AssetManager {
    if (!AssetManager.instance) {
      AssetManager.instance = new AssetManager();
    }
    return AssetManager.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Set up temp asset directories
      const baseDir = path.join(process.cwd(), "temp", "assets");
      const assetTypes: AssetType[] = [
        "music",
        "watermark",
        "overlay",
        "template",
        "lottie"
      ];

      for (const type of assetTypes) {
        const assetPath = path.join(baseDir, type);
        await fs.mkdir(assetPath, { recursive: true });
        this.assetPaths.set(type, assetPath);
      }

      // Clean up any stale assets on startup
      await this.cleanupStaleAssets();

      this.initialized = true;
      logger.info("Asset manager initialized with temp directories");
    } catch (error) {
      logger.error("Failed to initialize asset manager:", error);
      throw error;
    }
  }

  public async getAssetPath(type: AssetType, name: string, s3Key?: string): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    const basePath = this.assetPaths.get(type);
    if (!basePath) {
      throw new Error(`Invalid asset type: ${type}`);
    }

    // Generate cache key
    const cacheKey = s3Key || `${type}/${name}`;
    
    // Check memory cache first
    const cached = this.assetCache.get(cacheKey);
    if (cached && cached.expiresAt > new Date()) {
      try {
        await fs.access(cached.localPath);
        return cached.localPath;
      } catch {
        // File doesn't exist, remove from cache
        this.assetCache.delete(cacheKey);
      }
    }

    // Check DB cache
    const dbCached = await this.prisma.cachedAsset.findUnique({
      where: { cacheKey },
    });

    if (dbCached && new Date(dbCached.metadata.expiresAt) > new Date()) {
      try {
        await fs.access(dbCached.path);
        // Update memory cache
        this.assetCache.set(cacheKey, {
          localPath: dbCached.path,
          expiresAt: new Date(dbCached.metadata.expiresAt)
        });
        return dbCached.path;
      } catch {
        // File doesn't exist, remove from DB cache
        await this.prisma.cachedAsset.delete({
          where: { cacheKey }
        });
      }
    }

    // Download from S3 if s3Key provided
    if (s3Key) {
      const localPath = path.join(basePath, name);
      await s3Service.downloadToFile(s3Key, localPath);
      
      const expiresAt = new Date(Date.now() + this.CACHE_TTL);
      
      // Update both caches
      this.assetCache.set(cacheKey, { localPath, expiresAt });
      await this.prisma.cachedAsset.create({
        data: {
          type,
          path: localPath,
          cacheKey,
          metadata: {
            s3Key,
            expiresAt: expiresAt.toISOString()
          }
        }
      });

      return localPath;
    }

    // If no S3 key, check local assets
    const assetPath = path.join(basePath, name);
    try {
      await fs.access(assetPath);
      return assetPath;
    } catch (error) {
      throw new Error(`Asset not found: ${name} (type: ${type})`);
    }
  }

  private async cleanupStaleAssets(): Promise<void> {
    try {
      const now = new Date();

      // Clean up memory cache
      for (const [key, cached] of this.assetCache.entries()) {
        if (cached.expiresAt <= now) {
          try {
            await fs.unlink(cached.localPath);
          } catch (error) {
            logger.warn(`Failed to delete stale asset: ${cached.localPath}`, error);
          }
          this.assetCache.delete(key);
        }
      }

      // Clean up DB cache
      const staleAssets = await this.prisma.cachedAsset.findMany({
        where: {
          metadata: {
            path: ['expiresAt'],
            lt: now.toISOString()
          }
        }
      });

      for (const asset of staleAssets) {
        try {
          await fs.unlink(asset.path);
        } catch (error) {
          logger.warn(`Failed to delete stale asset: ${asset.path}`, error);
        }
      }

      await this.prisma.cachedAsset.deleteMany({
        where: {
          metadata: {
            path: ['expiresAt'],
            lt: now.toISOString()
          }
        }
      });

    } catch (error) {
      logger.error("Error during stale asset cleanup:", error);
    }
  }

  public async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
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
}

export const assetManager = new AssetManager();
