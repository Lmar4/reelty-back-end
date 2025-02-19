import path from "path";
import fs from "fs/promises";
import { logger } from "../../utils/logger";

type AssetType = "music" | "watermark" | "overlay" | "template";

class AssetManager {
  private assetPaths: Map<AssetType, string>;
  private initialized: boolean;

  constructor() {
    this.assetPaths = new Map();
    this.initialized = false;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Set up asset directories
      const baseDir = path.join(process.cwd(), "assets");
      const assetTypes: AssetType[] = [
        "music",
        "watermark",
        "overlay",
        "template",
      ];

      for (const type of assetTypes) {
        const assetPath = path.join(baseDir, type);
        await fs.mkdir(assetPath, { recursive: true });
        this.assetPaths.set(type, assetPath);
      }

      this.initialized = true;
      logger.info("Asset manager initialized");
    } catch (error) {
      logger.error("Failed to initialize asset manager:", error);
      throw error;
    }
  }

  public async getAssetPath(type: AssetType, name: string): Promise<string> {
    const basePath = this.assetPaths.get(type);
    if (!basePath) {
      throw new Error(`Invalid asset type: ${type}`);
    }

    const assetPath = path.join(basePath, name);
    try {
      await fs.access(assetPath);
      return assetPath;
    } catch (error) {
      throw new Error(`Asset not found: ${name} (type: ${type})`);
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
