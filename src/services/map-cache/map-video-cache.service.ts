/**
 * Map Video Cache Service
 *
 * Manages caching of generated map videos to improve performance and reduce resource usage.
 * Implements a size-limited LRU-like cache with automatic cleanup of expired entries.
 *
 * Features:
 * - Automatic cache cleanup
 * - Size-limited cache
 * - Cache entry expiration
 * - Cache statistics
 *
 * @module MapVideoCacheService
 */

import { createHash } from "crypto";
import fs from "fs";
import { logger } from "../../utils/logger";
import { MAP_CAPTURE_CONFIG } from "../map-capture/map-capture.config";

/**
 * Represents a cached map video entry
 */
interface CacheEntry {
  /** Path to the cached video file */
  path: string;
  /** When the entry was created */
  createdAt: Date;
  /** When the entry should be considered expired */
  expiresAt: Date;
  /** Coordinates used to generate the video */
  coordinates: {
    lat: number;
    lng: number;
  };
}

export class MapVideoCacheService {
  private static instance: MapVideoCacheService;
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Private constructor for singleton pattern.
   * Initializes periodic cache cleanup.
   */
  private constructor() {
    // Add periodic cleanup
    setInterval(
      () => this.cleanup(),
      MAP_CAPTURE_CONFIG.CACHE.CLEANUP_INTERVAL
    );
  }

  /**
   * Gets the singleton instance of MapVideoCacheService.
   * @returns {MapVideoCacheService} The singleton instance
   */
  public static getInstance(): MapVideoCacheService {
    if (!MapVideoCacheService.instance) {
      MapVideoCacheService.instance = new MapVideoCacheService();
    }
    return MapVideoCacheService.instance;
  }

  /**
   * Generates a cache key from coordinates.
   * Rounds coordinates to 6 decimal places for consistency.
   * @param {Object} coordinates - Latitude and longitude coordinates
   * @returns {string} MD5 hash of the rounded coordinates
   */
  private generateCacheKey(coordinates: { lat: number; lng: number }): string {
    // Round coordinates to 6 decimal places and create hash
    const lat = Math.round(coordinates.lat * 1000000) / 1000000;
    const lng = Math.round(coordinates.lng * 1000000) / 1000000;
    const coordString = `${lat},${lng}`;
    return createHash("md5").update(coordString).digest("hex");
  }

  /**
   * Checks if a cache entry has expired.
   * @param {CacheEntry} entry - Cache entry to check
   * @returns {boolean} True if the entry has expired
   */
  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt < new Date();
  }

  /**
   * Enforces the maximum cache size by removing oldest entries.
   */
  private async enforceMaxCacheSize(): Promise<void> {
    if (this.cache.size > MAP_CAPTURE_CONFIG.CACHE.MAX_SIZE) {
      const entries = Array.from(this.cache.entries()).sort(
        (a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime()
      );

      while (this.cache.size > MAP_CAPTURE_CONFIG.CACHE.MAX_SIZE) {
        const [key, entry] = entries.shift()!;
        try {
          await fs.promises.unlink(entry.path);
          this.cache.delete(key);
          logger.info("Removed oldest cache entry", { key, path: entry.path });
        } catch (error) {
          logger.error("Failed to remove cache entry", {
            error: error instanceof Error ? error.message : "Unknown error",
            key,
            path: entry.path,
          });
        }
      }
    }
  }

  /**
   * Gets a cached video or generates a new one if needed.
   * @param {Object} coordinates - Latitude and longitude coordinates
   * @param {Function} generator - Function to generate new video if needed
   * @param {string} jobId - Unique identifier for the job
   * @returns {Promise<string>} Path to the video file
   */
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
      try {
        await fs.promises.unlink(cached.path);
      } catch (error) {
        logger.warn("Failed to delete expired cache file", {
          error: error instanceof Error ? error.message : "Unknown error",
          path: cached.path,
        });
      }
      this.cache.delete(key);
    }

    logger.info(`[${jobId}] Cache miss for map video, generating new`, {
      coordinates,
      cacheKey: key,
    });

    const videoPath = await generator();
    await this.enforceMaxCacheSize();

    this.cache.set(key, {
      path: videoPath,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + MAP_CAPTURE_CONFIG.CACHE.DURATION),
      coordinates,
    });

    return videoPath;
  }

  /**
   * Performs cleanup of expired cache entries.
   * Automatically called periodically.
   */
  async cleanup(): Promise<void> {
    const expired = Array.from(this.cache.entries()).filter(([_, entry]) =>
      this.isExpired(entry)
    );

    for (const [key, entry] of expired) {
      try {
        await fs.promises.unlink(entry.path);
        this.cache.delete(key);
        logger.info("Cleaned up expired cache entry", {
          key,
          path: entry.path,
        });
      } catch (error) {
        logger.error("Failed to cleanup cache entry", {
          error: error instanceof Error ? error.message : "Unknown error",
          key,
          path: entry.path,
        });
      }
    }
  }

  /**
   * Gets statistics about the current cache state.
   * @returns {Object} Cache statistics including size and entry timestamps
   */
  public getCacheStats(): {
    size: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  } {
    const entries = Array.from(this.cache.values());
    return {
      size: this.cache.size,
      oldestEntry: entries.length
        ? entries.reduce(
            (oldest, entry) =>
              entry.createdAt < oldest ? entry.createdAt : oldest,
            entries[0].createdAt
          )
        : null,
      newestEntry: entries.length
        ? entries.reduce(
            (newest, entry) =>
              entry.createdAt > newest ? entry.createdAt : newest,
            entries[0].createdAt
          )
        : null,
    };
  }
}

export const mapVideoCacheService = MapVideoCacheService.getInstance();
