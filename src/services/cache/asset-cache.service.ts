import { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger";
import * as fs from "fs/promises";
import * as crypto from "crypto";

interface CacheOptions {
  type: "runway" | "map" | "webp" | "video";
  settings?: Record<string, any>;
  ttl?: number;
}

export class AssetCacheService {
  private static instance: AssetCacheService;
  private readonly prisma: PrismaClient;
  private readonly DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): AssetCacheService {
    if (!AssetCacheService.instance) {
      AssetCacheService.instance = new AssetCacheService();
    }
    return AssetCacheService.instance;
  }

  private async generateHash(filePath: string): Promise<string> {
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash("md5").update(fileBuffer).digest("hex");
  }

  async getCachedAsset(cacheKey: string): Promise<string | null> {
    try {
      const cached = await this.prisma.processedAsset.findUnique({
        where: { cacheKey },
      });

      if (cached) {
        try {
          await fs.access(cached.path);
          return cached.path;
        } catch {
          // File doesn't exist, clean up the record
          await this.prisma.processedAsset.delete({
            where: { id: cached.id },
          });
        }
      }

      return null;
    } catch (error) {
      logger.error("Failed to get cached asset", {
        cacheKey,
        error,
      });
      return null;
    }
  }

  async cacheAsset(
    path: string,
    cacheKey: string,
    options: CacheOptions
  ): Promise<void> {
    try {
      const hash = await this.generateHash(path);
      const expiresAt = new Date(
        Date.now() + (options.ttl || this.DEFAULT_TTL)
      );

      await this.prisma.processedAsset.upsert({
        where: { cacheKey },
        update: {
          path,
          hash,
          updatedAt: new Date(),
          settings: options.settings || {},
          metadata: {
            type: options.type,
            expiresAt: expiresAt.toISOString(),
          },
        },
        create: {
          type: options.type,
          path,
          cacheKey,
          hash,
          settings: options.settings || {},
          metadata: {
            type: options.type,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
    } catch (error) {
      logger.error("Failed to cache asset", {
        path,
        cacheKey,
        options,
        error,
      });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    try {
      const expiredAssets = await this.prisma.processedAsset.findMany({
        where: {
          metadata: {
            not: {
              equals: null,
            },
          },
        },
      });

      for (const asset of expiredAssets) {
        const metadata = asset.metadata as { expiresAt: string };
        if (new Date(metadata.expiresAt) < new Date()) {
          try {
            await fs.unlink(asset.path);
            await this.prisma.processedAsset.delete({
              where: { id: asset.id },
            });
          } catch (error) {
            logger.error("Failed to cleanup cached asset", {
              assetId: asset.id,
              path: asset.path,
              error,
            });
          }
        }
      }
    } catch (error) {
      logger.error("Failed to run cache cleanup", { error });
    }
  }
}

export const assetCacheService = AssetCacheService.getInstance();
