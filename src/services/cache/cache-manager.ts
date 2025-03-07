import {
  CacheEntry,
  CacheKey,
  ProcessingPromise,
} from "../../types/video-processing.js";
import { s3Service } from "../storage/s3.service.js";
import { imageProcessor } from "../imageProcessing/image.service.js";
import { runwayService } from "../video/runway.service.js";
import path from "path";
import fs from "fs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "stream";

export class AssetCacheManager {
  private static instance: AssetCacheManager;
  private caches: Map<
    string,
    Map<CacheKey, CacheEntry<ProcessingPromise<any>>>
  > = new Map();
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  private s3Client: S3Client;

  private constructor() {
    // Initialize separate caches for different asset types
    this.caches.set("s3", new Map());
    this.caches.set("processed-images", new Map());
    this.caches.set("video-segments", new Map());
    this.caches.set("templates", new Map());

    // Initialize S3 client
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  static getInstance(): AssetCacheManager {
    if (!AssetCacheManager.instance) {
      AssetCacheManager.instance = new AssetCacheManager();
    }
    return AssetCacheManager.instance;
  }

  private getCache(
    type: string
  ): Map<CacheKey, CacheEntry<ProcessingPromise<any>>> {
    const cache = this.caches.get(type);
    if (!cache) {
      throw new Error(`Cache type ${type} not found`);
    }
    return cache;
  }

  private setCacheEntry<T>(
    type: string,
    key: CacheKey,
    promise: ProcessingPromise<T>
  ): ProcessingPromise<T> {
    const cache = this.getCache(type);
    const entry: CacheEntry<ProcessingPromise<T>> = {
      data: promise,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.CACHE_DURATION,
    };
    cache.set(key, entry);
    return promise;
  }

  private getCacheEntry<T>(
    type: string,
    key: CacheKey
  ): ProcessingPromise<T> | null {
    const cache = this.getCache(type);
    const entry = cache.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }

    return entry.data as ProcessingPromise<T>;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("error", (err) => reject(err));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  async getFromS3(key: string): Promise<Buffer> {
    const cached = this.getCacheEntry<Buffer>("s3", key);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const command = new GetObjectCommand({
          Bucket: process.env.AWS_BUCKET || "reelty-prod-storage",
          Key: key,
        });

        const response = await this.s3Client.send(command);
        if (!response.Body) {
          throw new Error(`No body in S3 response for key: ${key}`);
        }

        const buffer = await this.streamToBuffer(response.Body as Readable);
        return buffer;
      } catch (error) {
        console.error(`Failed to get object from S3: ${key}`, error);
        throw error;
      }
    })();

    return this.setCacheEntry("s3", key, promise);
  }

  async getProcessedImage(imageKey: string): Promise<string> {
    const cached = this.getCacheEntry<string>("processed-images", imageKey);
    if (cached) return cached;

    const promise = (async () => {
      const buffer = await this.getFromS3(imageKey);
      const dataUrl = await imageProcessor.bufferToDataUrl(buffer);
      return dataUrl;
    })();

    return this.setCacheEntry("processed-images", imageKey, promise);
  }

  async getVideoSegment(imageUrl: string, index: number): Promise<string> {
    const cacheKey = `${imageUrl}_${index}`;
    const cached = this.getCacheEntry<string>("video-segments", cacheKey);
    if (cached) return cached;

    const promise = runwayService.generateVideo(
      imageUrl,
      index,
      "default", // default listingId for cache manager
      cacheKey // using cacheKey as jobId for tracking
    );
    return this.setCacheEntry("video-segments", cacheKey, promise);
  }

  async getTemplateResult(cacheKey: string, videos: string[]): Promise<string> {
    // Validate inputs
    if (!videos || videos.length === 0) {
      throw new Error("Videos array is required for template processing");
    }

    const cached = this.getCacheEntry<string>("templates", cacheKey);
    if (cached) return cached;

    // Return a promise that will be cached
    // Include video paths in the placeholder to ensure uniqueness
    const promise = Promise.resolve(
      `processed_template_${cacheKey}_${videos
        .map((v) => v.split("/").pop())
        .join("_")}`
    );
    return this.setCacheEntry("templates", cacheKey, promise);
  }

  async updateTemplateResult(
    cacheKey: string,
    outputPath: string
  ): Promise<string> {
    return this.setCacheEntry(
      "templates",
      cacheKey,
      Promise.resolve(outputPath)
    );
  }

  clearCache(type?: string): void {
    if (type) {
      const cache = this.getCache(type);
      cache.clear();
    } else {
      this.caches.forEach((cache) => cache.clear());
    }
  }

  clearExpiredEntries(): void {
    const now = Date.now();
    this.caches.forEach((cache) => {
      for (const [key, entry] of cache.entries()) {
        if (now > entry.expiresAt) {
          cache.delete(key);
        }
      }
    });
  }
}

export const assetCacheManager = AssetCacheManager.getInstance();
