import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import * as fs from "fs/promises";
import * as crypto from "crypto";
import * as path from "path";
import {
  TemplateAssetType,
  TemplateAssetMetadata,
  TemplateAssetOptions,
} from "../assets/types";

interface CacheOptions {
  type: TemplateAssetType;
  settings?: Record<string, any>;
  ttl?: number;
}

interface CacheMetadata extends Record<string, unknown> {
  type: string;
  expiresAt: string;
  listingId?: string;
}

export class AssetCacheService {
  private static instance: AssetCacheService;
  private readonly prisma: PrismaClient;
  private readonly DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly LOCK_TIMEOUT = 60 * 1000; // 1 minute lock timeout
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // 1 second base delay
  private readonly processId: string;

  private constructor() {
    this.prisma = new PrismaClient();
    this.processId = `process_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
  }

  public static getInstance(): AssetCacheService {
    if (!AssetCacheService.instance) {
      AssetCacheService.instance = new AssetCacheService();
    }
    return AssetCacheService.instance;
  }

  private async generateHash(filePath: string): Promise<string> {
    try {
      const fileBuffer = await fs.readFile(filePath);
      return crypto.createHash("md5").update(fileBuffer).digest("hex");
    } catch (error) {
      logger.error("Failed to generate hash", {
        filePath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  private async cleanupExpiredLocks(): Promise<void> {
    try {
      await this.prisma.cacheLock.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(),
          },
        },
      });
    } catch (error) {
      logger.error("Failed to cleanup expired locks", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async acquireLock(
    cacheKey: string,
    tx: Prisma.TransactionClient
  ): Promise<string | null> {
    let retries = 0;
    const lockKey = `asset_${cacheKey}`;

    while (retries < this.MAX_RETRIES) {
      try {
        await this.cleanupExpiredLocks();

        // Try to acquire the lock
        const lock = await tx.cacheLock.create({
          data: {
            key: lockKey,
            owner: this.processId,
            expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
          },
        });

        return lock.id;
      } catch (error) {
        // If lock already exists, check if it's expired
        const existingLock = await tx.cacheLock.findUnique({
          where: { key: lockKey },
        });

        if (existingLock && existingLock.expiresAt < new Date()) {
          // Lock has expired, update it
          try {
            const updatedLock = await tx.cacheLock.update({
              where: { key: lockKey },
              data: {
                owner: this.processId,
                expiresAt: new Date(Date.now() + this.LOCK_TIMEOUT),
              },
            });
            return updatedLock.id;
          } catch (updateError) {
            // Another process might have acquired the lock
            logger.warn("Failed to update expired lock", {
              lockKey,
              error:
                updateError instanceof Error
                  ? updateError.message
                  : "Unknown error",
            });
          }
        }

        retries++;
        if (retries >= this.MAX_RETRIES) {
          logger.error("Failed to acquire lock after max retries", {
            lockKey,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return null;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, retries))
        );
      }
    }

    return null;
  }

  private async releaseLock(
    cacheKey: string,
    lockId: string,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    try {
      await tx.cacheLock.deleteMany({
        where: {
          id: lockId,
          key: `asset_${cacheKey}`,
          owner: this.processId,
        },
      });
    } catch (error) {
      logger.error("Failed to release lock", {
        cacheKey,
        lockId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === this.MAX_RETRIES) {
          logger.error(`${context} failed after ${this.MAX_RETRIES} attempts`, {
            error: error instanceof Error ? error.message : "Unknown error",
            attempt,
          });
          throw error;
        }

        const delay = this.RETRY_DELAY * Math.pow(2, attempt - 1);
        logger.warn(`${context} failed, retrying in ${delay}ms`, {
          error: error instanceof Error ? error.message : "Unknown error",
          attempt,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(`${context} failed after retries`);
  }

  async getCachedAsset(cacheKey: string): Promise<string | null> {
    return this.withRetry(async () => {
      return await this.prisma.$transaction(async (tx) => {
        try {
          const cached = await tx.processedAsset.findUnique({
            where: { cacheKey },
          });

          if (!cached) {
            return null;
          }

          try {
            await fs.access(cached.path);
            // Verify file integrity with hash
            const currentHash = await this.generateHash(cached.path);
            if (currentHash !== cached.hash) {
              logger.warn("Cache file hash mismatch", {
                cacheKey,
                path: cached.path,
                expectedHash: cached.hash,
                actualHash: currentHash,
              });
              await this.invalidateCache(cacheKey, tx);
              return null;
            }
            return cached.path;
          } catch (error) {
            // File doesn't exist or is inaccessible
            await this.invalidateCache(cacheKey, tx);
            return null;
          }
        } catch (error) {
          logger.error("Failed to get cached asset", {
            cacheKey,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return null;
        }
      });
    }, "Get cached asset");
  }

  private async invalidateCache(
    cacheKey: string,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    try {
      const asset = await tx.processedAsset.findUnique({
        where: { cacheKey },
      });

      if (asset) {
        try {
          await fs.unlink(asset.path);
        } catch (error) {
          logger.warn("Failed to delete invalid cache file", {
            path: asset.path,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }

        await tx.processedAsset.delete({
          where: { id: asset.id },
        });
      }
    } catch (error) {
      logger.error("Failed to invalidate cache", {
        cacheKey,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async cacheAsset(
    filePath: string,
    cacheKey: string,
    options: CacheOptions
  ): Promise<void> {
    return this.withRetry(async () => {
      await this.prisma.$transaction(async (tx) => {
        const lockId = await this.acquireLock(cacheKey, tx);
        if (!lockId) {
          throw new Error("Failed to acquire lock for cache update");
        }

        try {
          // Ensure file exists and is accessible
          await fs.access(filePath);
          const stats = await fs.stat(filePath);
          if (stats.size === 0) {
            throw new Error("File is empty");
          }

          const hash = await this.generateHash(filePath);
          const expiresAt = new Date(
            Date.now() + (options.ttl || this.DEFAULT_TTL)
          );

          // Create a copy of the file in the cache directory
          const cacheDir = process.env.CACHE_DIR || "cache";
          const cachedFilePath = path.join(
            cacheDir,
            `${cacheKey}_${hash}${path.extname(filePath)}`
          );

          await fs.mkdir(path.dirname(cachedFilePath), { recursive: true });
          await fs.copyFile(filePath, cachedFilePath);

          const metadata: CacheMetadata = {
            type: options.type,
            expiresAt: expiresAt.toISOString(),
          };

          await tx.processedAsset.upsert({
            where: { cacheKey },
            update: {
              path: cachedFilePath,
              hash,
              updatedAt: new Date(),
              settings: options.settings || {},
              metadata: metadata as Prisma.InputJsonValue,
            },
            create: {
              type: options.type,
              path: cachedFilePath,
              cacheKey,
              hash,
              settings: options.settings || {},
              metadata: metadata as Prisma.InputJsonValue,
            },
          });

          logger.info("Asset cached successfully", {
            cacheKey,
            path: cachedFilePath,
            type: options.type,
            expiresAt: expiresAt.toISOString(),
          });
        } catch (error) {
          logger.error("Failed to cache asset", {
            path: filePath,
            cacheKey,
            options,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        } finally {
          await this.releaseLock(cacheKey, lockId, tx);
        }
      });
    }, "Cache asset");
  }

  async cleanup(): Promise<void> {
    return this.withRetry(async () => {
      await this.prisma.$transaction(async (tx) => {
        try {
          const expiredAssets = await tx.processedAsset.findMany({
            where: {
              metadata: {
                path: ["expiresAt"],
                lt: new Date().toISOString(),
              },
            },
          });

          for (const asset of expiredAssets) {
            const lockId = await this.acquireLock(asset.cacheKey, tx);
            if (!lockId) {
              logger.warn("Skipping cleanup for locked asset", {
                assetId: asset.id,
                cacheKey: asset.cacheKey,
              });
              continue;
            }

            try {
              await fs.unlink(asset.path);
              await tx.processedAsset.delete({
                where: { id: asset.id },
              });

              logger.info("Cleaned up expired asset", {
                assetId: asset.id,
                path: asset.path,
              });
            } catch (error) {
              logger.error("Failed to cleanup cached asset", {
                assetId: asset.id,
                path: asset.path,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            } finally {
              await this.releaseLock(asset.cacheKey, lockId, tx);
            }
          }
        } catch (error) {
          logger.error("Failed to run cache cleanup", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      });
    }, "Cache cleanup");
  }

  private getTemplateCacheKey(
    type: TemplateAssetType,
    metadata: TemplateAssetMetadata
  ): string {
    const { jobId, templateKey, index, listingId } = metadata;
    switch (type) {
      case "runway":
        return `runway_${jobId}_${index}`;
      case "map":
        if (!listingId) throw new Error("listingId required for map assets");
        return `map_${jobId}_${listingId}`;
      case "watermark":
        return `watermark_${jobId}`;
      case "music":
        return `music_${templateKey}_${jobId}`;
      default:
        throw new Error(`Invalid template asset type: ${type}`);
    }
  }

  async getCachedTemplateAsset(
    type: TemplateAssetType,
    metadata: TemplateAssetMetadata
  ): Promise<string | null> {
    const cacheKey = this.getTemplateCacheKey(type, metadata);
    return this.getCachedAsset(cacheKey);
  }

  async cacheTemplateAsset(
    filePath: string,
    options: TemplateAssetOptions
  ): Promise<void> {
    const cacheKey = this.getTemplateCacheKey(options.type, options.metadata);
    const metadata: CacheMetadata = {
      type: options.type,
      expiresAt: new Date(
        Date.now() + (options.ttl || this.DEFAULT_TTL)
      ).toISOString(),
      listingId: options.metadata.listingId,
    };

    await this.cacheAsset(filePath, cacheKey, {
      type: options.type,
      settings: options.settings,
      ttl: options.ttl || this.DEFAULT_TTL,
    });
  }

  async cleanupTemplateAssets(jobId: string): Promise<void> {
    return this.withRetry(async () => {
      await this.prisma.$transaction(async (tx) => {
        try {
          const expiredAssets = await tx.processedAsset.findMany({
            where: {
              cacheKey: {
                contains: jobId,
              },
            },
          });

          for (const asset of expiredAssets) {
            const lockId = await this.acquireLock(asset.cacheKey, tx);
            if (!lockId) {
              logger.warn("Skipping cleanup for locked template asset", {
                assetId: asset.id,
                cacheKey: asset.cacheKey,
                jobId,
              });
              continue;
            }

            try {
              await fs.unlink(asset.path);
              await tx.processedAsset.delete({
                where: { id: asset.id },
              });

              logger.info("Cleaned up template asset", {
                assetId: asset.id,
                path: asset.path,
                jobId,
              });
            } catch (error) {
              logger.error("Failed to cleanup template asset", {
                assetId: asset.id,
                path: asset.path,
                jobId,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            } finally {
              await this.releaseLock(asset.cacheKey, lockId, tx);
            }
          }
        } catch (error) {
          logger.error("Failed to run template assets cleanup", {
            jobId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      });
    }, "Template assets cleanup");
  }
}

export const assetCacheService = AssetCacheService.getInstance();
