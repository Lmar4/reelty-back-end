// src/services/map-cache/map-video-cache.service.ts
import { createHash } from "crypto";
import fs from "fs";
import { logger } from "../../utils/logger";

interface CacheEntry {
  path: string;
  createdAt: Date;
  expiresAt: Date;
  coordinates: {
    lat: number;
    lng: number;
  };
}

export class MapVideoCacheService {
  private static instance: MapVideoCacheService;
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  private constructor() {}

  public static getInstance(): MapVideoCacheService {
    if (!MapVideoCacheService.instance) {
      MapVideoCacheService.instance = new MapVideoCacheService();
    }
    return MapVideoCacheService.instance;
  }

  private generateCacheKey(coordinates: { lat: number; lng: number }): string {
    // Round coordinates to 6 decimal places and create hash
    const lat = Math.round(coordinates.lat * 1000000) / 1000000;
    const lng = Math.round(coordinates.lng * 1000000) / 1000000;
    const coordString = `${lat},${lng}`;
    return createHash("md5").update(coordString).digest("hex");
  }

  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt < new Date();
  }

  async getOrGenerate(
    coordinates: { lat: number; lng: number },
    generator: () => Promise<string>,
    jobId: string
  ): Promise<string> {
    const key = this.generateCacheKey(coordinates);
    const cached = this.cache.get(key);

    if (cached && !this.isExpired(cached)) {
      logger.info(`[${jobId}] Cache hit for map video`, {
        coordinates,
        cacheKey: key,
      });
      return cached.path;
    }

    if (cached) {
      logger.info(`[${jobId}] Cache expired for map video`, {
        coordinates,
        cacheKey: key,
      });
      // Cleanup expired cache entry
      await fs.promises.unlink(cached.path);
      this.cache.delete(key);
    }

    logger.info(`[${jobId}] Cache miss for map video, generating new`, {
      coordinates,
      cacheKey: key,
    });

    const videoPath = await generator();

    this.cache.set(key, {
      path: videoPath,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.CACHE_DURATION),
      coordinates,
    });

    return videoPath;
  }

  async cleanup(): Promise<void> {
    const expired = Array.from(this.cache.entries()).filter(([_, entry]) =>
      this.isExpired(entry)
    );

    for (const [key, entry] of expired) {
      await fs.promises.unlink(entry.path);
      this.cache.delete(key);
    }
  }
}

export const mapVideoCacheService = MapVideoCacheService.getInstance();
