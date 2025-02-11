import { PrismaClient, Prisma } from "@prisma/client";
import { createHash } from "crypto";

interface CachedAsset {
  id: string;
  type: "webp" | "video" | "map";
  path: string;
  metadata: {
    timestamp: Date;
    settings: Record<string, unknown>;
    hash: string;
  };
}

export class AssetCacheService {
  private static instance: AssetCacheService;
  private prisma: PrismaClient;

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): AssetCacheService {
    if (!AssetCacheService.instance) {
      AssetCacheService.instance = new AssetCacheService();
    }
    return AssetCacheService.instance;
  }

  private generateHash(
    input: string,
    settings?: Record<string, unknown>
  ): string {
    const content = settings ? `${input}-${JSON.stringify(settings)}` : input;
    return createHash("sha256").update(content).digest("hex");
  }

  async getCachedAsset(
    input: string,
    type: CachedAsset["type"],
    settings?: Record<string, unknown>
  ): Promise<CachedAsset | null> {
    const hash = this.generateHash(input, settings);

    const cachedAsset = await this.prisma.processedAsset.findFirst({
      where: {
        hash,
        type,
      },
    });

    if (!cachedAsset) {
      return null;
    }

    return this.mapToCachedAsset(cachedAsset);
  }

  async cacheAsset(asset: Omit<CachedAsset, "id">): Promise<CachedAsset> {
    const hash = this.generateHash(asset.path, asset.metadata.settings);

    const cachedAsset = await this.prisma.processedAsset.create({
      data: {
        type: asset.type,
        path: asset.path,
        hash,
        settings: asset.metadata.settings as Prisma.InputJsonValue,
      },
    });

    return this.mapToCachedAsset(cachedAsset);
  }

  async invalidateAsset(id: string): Promise<void> {
    await this.prisma.processedAsset.delete({
      where: { id },
    });
  }

  async invalidateByType(type: CachedAsset["type"]): Promise<void> {
    await this.prisma.processedAsset.deleteMany({
      where: { type },
    });
  }

  async getAssetsByInput(input: string): Promise<CachedAsset[]> {
    const hash = this.generateHash(input);

    const assets = await this.prisma.processedAsset.findMany({
      where: {
        hash: {
          startsWith: hash.substring(0, 32), // Use first 32 chars for partial matching
        },
      },
    });

    return assets.map(this.mapToCachedAsset);
  }

  private mapToCachedAsset(
    asset: Prisma.ProcessedAssetGetPayload<{}>
  ): CachedAsset {
    return {
      id: asset.id,
      type: asset.type as CachedAsset["type"],
      path: asset.path,
      metadata: {
        timestamp: asset.createdAt,
        settings: (asset.settings as Record<string, unknown>) ?? {},
        hash: asset.hash,
      },
    };
  }
}
