import path from "path";
import fs from "fs/promises";
import { logger } from "../../utils/logger";
import { s3Service } from "../storage/s3.service";
import {
  PrismaClient,
  ProcessedAsset,
  Prisma,
  AssetType,
} from "@prisma/client";
import * as crypto from "crypto";

interface CachedAsset {
  path: string;
  expiresAt: Date;
}

interface AssetMetadata {
  expiresAt: string;
  localPath?: string;
}

export class AssetManager {
  private static instance: AssetManager;
  private readonly prisma: PrismaClient;
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly assetPaths: Map<AssetType, string>;

  private constructor() {
    this.prisma = new PrismaClient();
    this.assetPaths = new Map([
      [AssetType.MUSIC, path.join(process.cwd(), "temp", "assets", "music")],
      [
        AssetType.WATERMARK,
        path.join(process.cwd(), "temp", "assets", "watermarks"),
      ],
      [AssetType.LOTTIE, path.join(process.cwd(), "temp", "assets", "lottie")],
    ]);
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

  async getAssetPath(
    type: AssetType,
    name: string,
    s3Key?: string
  ): Promise<string> {
    try {
      const cacheKey = s3Key || `${type}/${name}`;

      // Check ProcessedAsset cache first
      const cached = await this.prisma.processedAsset.findUnique({
        where: { cacheKey },
      });

      if (cached) {
        const metadata = cached.metadata as unknown as AssetMetadata;
        if (new Date(metadata.expiresAt) > new Date() && metadata.localPath) {
          try {
            await fs.access(metadata.localPath);
            return metadata.localPath;
          } catch {
            // File doesn't exist, continue to download
          }
        }
      }

      // Get or create asset directory
      const basePath =
        this.assetPaths.get(type) ||
        path.join(process.cwd(), "temp", "assets", type);
      await fs.mkdir(basePath, { recursive: true });

      const localPath = path.join(basePath, name);

      if (s3Key) {
        await s3Service.downloadFile(s3Key, localPath);

        const expiresAt = new Date(Date.now() + this.CACHE_TTL);
        const hash = this.generateHash(localPath);

        // Update or create cache entry
        await this.prisma.processedAsset.upsert({
          where: { cacheKey },
          update: {
            path: localPath,
            hash,
            updatedAt: new Date(),
            metadata: {
              expiresAt: expiresAt.toISOString(),
              localPath,
            },
          },
          create: {
            type: "asset",
            path: localPath,
            cacheKey,
            hash,
            metadata: {
              expiresAt: expiresAt.toISOString(),
              localPath,
            },
          },
        });

        return localPath;
      }

      // For local assets, just verify existence
      await fs.access(localPath);
      return localPath;
    } catch (error) {
      logger.error("Failed to get asset path", {
        type,
        name,
        s3Key,
        error,
      });
      throw error;
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
}

export const assetManager = AssetManager.getInstance();
