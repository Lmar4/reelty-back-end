import { PrismaClient, Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { TempFile } from "../storage/temp-file.service";

export type AssetType = "webp" | "runway" | "ffmpeg" | "map" | "template";

export interface CachedAsset {
  id: string;
  type: AssetType;
  path: string;
  cacheKey: string;
  metadata: {
    timestamp: Date;
    settings: Record<string, unknown>;
    hash: string;
    index?: number;
    localPath?: string;
  };
}

interface LockOptions {
  timeout?: number;
  retryInterval?: number;
  maxRetries?: number;
}

const DEFAULT_LOCK_OPTIONS: Required<LockOptions> = {
  timeout: 60000, // 60 seconds - doubled for large files
  retryInterval: 500, // 500ms - faster retries
  maxRetries: 10, // More retries for better resilience
};

export interface ProcessedImage {
  webpPath: TempFile;
  s3WebpPath: string;
  uploadPromise: Promise<void>;
}

export class AssetCacheService {
  private static instance: AssetCacheService;
  private prisma: PrismaClient;
  private processId: string;

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

  public generateCacheKey(
    type: AssetType,
    settings: Record<string, unknown>
  ): string {
    const settingsStr = JSON.stringify(settings, Object.keys(settings).sort());
    return createHash("sha256").update(`${type}:${settingsStr}`).digest("hex");
  }

  public generateHash(path: string): string {
    return createHash("sha256").update(path).digest("hex");
  }

  private async cleanupExpiredLocks(): Promise<void> {
    await this.prisma.cacheLock.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });
  }

  private async acquireLock(
    key: string,
    options: LockOptions = {}
  ): Promise<boolean> {
    const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
    let retries = 0;

    while (retries < opts.maxRetries) {
      try {
        await this.cleanupExpiredLocks();

        // Try to acquire the lock using a transaction
        await this.prisma.$transaction(async (tx) => {
          const existingLock = await tx.cacheLock.findUnique({
            where: { key },
          });

          if (existingLock) {
            if (existingLock.expiresAt < new Date()) {
              // Lock has expired, we can take it
              await tx.cacheLock.update({
                where: { key },
                data: {
                  owner: this.processId,
                  expiresAt: new Date(Date.now() + opts.timeout),
                  updatedAt: new Date(),
                },
              });
            } else {
              throw new Error("Lock is held by another process");
            }
          } else {
            // Create new lock
            await tx.cacheLock.create({
              data: {
                key,
                owner: this.processId,
                expiresAt: new Date(Date.now() + opts.timeout),
              },
            });
          }
        });

        return true;
      } catch (error) {
        retries++;
        if (retries >= opts.maxRetries) {
          console.error("Failed to acquire lock after max retries:", {
            key,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, opts.retryInterval));
      }
    }

    return false;
  }

  private async releaseLock(key: string): Promise<void> {
    try {
      await this.prisma.cacheLock.deleteMany({
        where: {
          key,
          owner: this.processId,
        },
      });
    } catch (error) {
      console.error("Error releasing lock:", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getCachedAsset(cacheKey: string): Promise<CachedAsset | null> {
    const lockAcquired = await this.acquireLock(`read_${cacheKey}`);
    if (!lockAcquired) {
      throw new Error("Failed to acquire read lock for cache operation");
    }

    try {
      const asset = await this.prisma.processedAsset.findUnique({
        where: { cacheKey },
      });

      if (!asset) {
        return null;
      }

      return {
        id: asset.id,
        type: asset.type as AssetType,
        path: asset.path,
        cacheKey: asset.cacheKey,
        metadata: {
          timestamp: asset.createdAt,
          settings: asset.settings as Record<string, unknown>,
          hash: asset.hash,
        },
      };
    } finally {
      await this.releaseLock(`read_${cacheKey}`);
    }
  }

  async cacheAsset(asset: {
    type: AssetType;
    path: string;
    cacheKey: string;
    metadata: {
      timestamp: Date;
      settings: Record<string, unknown>;
      hash: string;
      index?: number;
      localPath?: string;
    };
  }): Promise<CachedAsset> {
    const lockAcquired = await this.acquireLock(`write_${asset.cacheKey}`);
    if (!lockAcquired) {
      throw new Error("Failed to acquire write lock for cache operation");
    }

    try {
      const processedAsset = await this.prisma.processedAsset.upsert({
        where: {
          cacheKey: asset.cacheKey,
        },
        update: {
          path: asset.path,
          hash: asset.metadata.hash,
          settings: asset.metadata.settings as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
        create: {
          type: asset.type,
          path: asset.path,
          cacheKey: asset.cacheKey,
          hash: asset.metadata.hash,
          settings: asset.metadata.settings as Prisma.InputJsonValue,
        },
      });

      return {
        id: processedAsset.id,
        type: processedAsset.type as AssetType,
        path: processedAsset.path,
        cacheKey: processedAsset.cacheKey,
        metadata: {
          timestamp: processedAsset.createdAt,
          settings: processedAsset.settings as Record<string, unknown>,
          hash: processedAsset.hash,
        },
      };
    } finally {
      await this.releaseLock(`write_${asset.cacheKey}`);
    }
  }

  async invalidateAsset(id: string): Promise<void> {
    const asset = await this.prisma.processedAsset.findUnique({
      where: { id },
    });

    if (!asset) return;

    const lockAcquired = await this.acquireLock(`invalidate_${asset.cacheKey}`);
    if (!lockAcquired) {
      throw new Error("Failed to acquire lock for cache invalidation");
    }

    try {
      await this.prisma.processedAsset.delete({
        where: { id },
      });
    } finally {
      await this.releaseLock(`invalidate_${asset.cacheKey}`);
    }
  }

  async invalidateByType(type: AssetType): Promise<void> {
    const lockAcquired = await this.acquireLock(`invalidate_type_${type}`);
    if (!lockAcquired) {
      throw new Error("Failed to acquire lock for type invalidation");
    }

    try {
      await this.prisma.processedAsset.deleteMany({
        where: { type },
      });
    } finally {
      await this.releaseLock(`invalidate_type_${type}`);
    }
  }

  async getAssetsByInput(input: string): Promise<CachedAsset[]> {
    const hash = this.generateHash(input);
    const lockAcquired = await this.acquireLock(`read_input_${hash}`);
    if (!lockAcquired) {
      console.warn("Failed to acquire read lock for input hash:", hash);
      return [];
    }

    try {
      const assets = await this.prisma.processedAsset.findMany({
        where: {
          hash: {
            startsWith: hash.substring(0, 32),
          },
        },
      });

      return assets.map((asset) => ({
        id: asset.id,
        type: asset.type as AssetType,
        path: asset.path,
        cacheKey: asset.cacheKey,
        metadata: {
          timestamp: asset.createdAt,
          settings: (asset.settings as Record<string, unknown>) ?? {},
          hash: asset.hash,
        },
      }));
    } finally {
      await this.releaseLock(`read_input_${hash}`);
    }
  }
}
