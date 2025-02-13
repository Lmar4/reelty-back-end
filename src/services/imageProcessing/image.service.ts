import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { Readable } from "stream";
import { AssetCacheService, AssetType } from "../cache/assetCache";
import { s3Service } from "../storage/s3.service";
import { TempFile } from "../storage/temp-file.service";

const prisma = new PrismaClient();

export interface ImageValidation {
  isValid: boolean;
  error?: string;
}

export interface ProcessingOptions extends Record<string, unknown> {
  width?: number;
  height?: number;
  quality?: number;
  format?: string;
  fit?: keyof sharp.FitEnum;
  effort?: number;
  smartSubsample?: boolean;
  mixed?: boolean;
}

export interface ProcessedImage {
  webpPath: TempFile;
  s3WebpPath: string;
  uploadPromise: Promise<void>;
}

export class ImageProcessor {
  private readonly DEFAULT_BATCH_SIZE = 3;
  private readonly DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB
  private readonly MAX_RETRIES = 3;
  private readonly MAX_CONCURRENT_OPERATIONS = 3;
  private assetCache: AssetCacheService;

  constructor() {
    this.assetCache = AssetCacheService.getInstance();
  }

  private cleanUrl(url: string): string {
    // Remove query parameters from URL
    return url.split("?")[0];
  }

  private getFilenameFromUrl(url: string): string {
    const cleanUrl = this.cleanUrl(url);
    return path.basename(cleanUrl);
  }

  private async retryOperation<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === this.MAX_RETRIES) break;

        // Calculate delay with exponential backoff
        const delay = Math.min(
          1000 * Math.pow(2, attempt - 1),
          30000 // Max 30 seconds
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  private async getCachedWebP(
    url: string,
    options: ProcessingOptions = {}
  ): Promise<ProcessedImage | null> {
    const cacheKey = this.assetCache.generateCacheKey("webp" as AssetType, {
      path: url,
      ...options,
    });

    const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);

    if (cachedAsset) {
      const tempFile: TempFile = {
        path: cachedAsset.path,
        filename: path.basename(cachedAsset.path),
        cleanup: async () => {
          /* No cleanup needed for cached files */
        },
      };

      return {
        webpPath: tempFile,
        s3WebpPath: cachedAsset.path,
        uploadPromise: Promise.resolve(),
      };
    }

    // Process the image
    const processedImage = await this.processImage(url, options);

    // Cache the result
    await this.assetCache.cacheAsset({
      type: "webp" as AssetType,
      path: processedImage.s3WebpPath,
      cacheKey,
      metadata: {
        timestamp: new Date(),
        settings: options,
        hash: this.assetCache.generateHash(processedImage.s3WebpPath),
      },
    });

    return processedImage;
  }

  private async cacheWebP(
    url: string,
    webpPath: string,
    options: ProcessingOptions = {}
  ): Promise<void> {
    const cacheKey = this.assetCache.generateCacheKey("webp" as AssetType, {
      path: url,
      ...options,
    });

    await this.assetCache.cacheAsset({
      type: "webp" as AssetType,
      path: webpPath,
      cacheKey,
      metadata: {
        timestamp: new Date(),
        settings: options,
        hash: this.assetCache.generateHash(webpPath),
      },
    });
  }

  public async validateImage(buffer: Buffer): Promise<ImageValidation> {
    return this.retryOperation(async () => {
      try {
        const image = sharp(buffer);
        const metadata = await image.metadata();

        // Check if it's a valid image format
        if (
          !metadata.format ||
          !["jpeg", "jpg", "png", "webp"].includes(metadata.format)
        ) {
          return {
            isValid: false,
            error: `Unsupported image format: ${metadata.format}`,
          };
        }

        // Check if image dimensions are valid
        if (!metadata.width || !metadata.height) {
          return {
            isValid: false,
            error: "Invalid image dimensions",
          };
        }

        // Check if image is corrupted by trying to get its buffer
        await image.toBuffer();

        return { isValid: true };
      } catch (error) {
        return {
          isValid: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });
  }

  public async convertToWebP(
    buffer: Buffer,
    options: ProcessingOptions = {}
  ): Promise<Buffer> {
    return this.retryOperation(async () => {
      const image = sharp(buffer, {
        failOnError: true,
        limitInputPixels: Math.pow(2, 24), // Reasonable limit for memory
      });

      if (options.width || options.height) {
        image.resize(options.width, options.height, {
          fit: options.fit || "contain",
          withoutEnlargement: true,
          fastShrinkOnLoad: true,
          kernel: "lanczos3",
        });
      }

      return image
        .webp({
          quality: options.quality || 80,
          effort: options.effort || 4,
          lossless: false,
          nearLossless: false,
          smartSubsample: options.smartSubsample ?? true,
          mixed: options.mixed ?? true,
        })
        .toBuffer();
    });
  }

  public async processBatch(s3Paths: string[]): Promise<ProcessedImage[]> {
    console.log("Starting batch processing:", { count: s3Paths.length });
    const results: ProcessedImage[] = [];
    const batchSize = this.MAX_CONCURRENT_OPERATIONS;

    for (let i = 0; i < s3Paths.length; i += batchSize) {
      const batch = s3Paths.slice(i, i + batchSize);
      console.log(`Processing batch ${i / batchSize + 1}:`, {
        size: batch.length,
        remaining: s3Paths.length - (i + batch.length),
      });

      const batchResults = await Promise.all(
        batch.map((path) => this.processImage(path))
      );
      results.push(...batchResults);

      // Add a small delay between batches to prevent rate limiting
      if (i + batchSize < s3Paths.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  private async downloadInChunks(
    s3Path: string,
    chunkSize: number = this.DEFAULT_CHUNK_SIZE
  ): Promise<Buffer> {
    return this.retryOperation(async () => {
      const chunks: Buffer[] = [];
      const { bucket, key } = s3Service.parseUrl(s3Path);
      const stream = await s3Service.downloadFile(s3Path);

      // If we already have a Buffer, return it directly
      if (Buffer.isBuffer(stream)) {
        return stream;
      }

      // Otherwise, handle as a stream
      return new Promise<Buffer>((resolve, reject) => {
        const readable = stream as Readable;
        readable.on("data", (chunk: Buffer) => chunks.push(chunk));
        readable.on("end", () => resolve(Buffer.concat(chunks)));
        readable.on("error", reject);
      });
    });
  }

  public async processImage(
    inputPath: string,
    options: ProcessingOptions = {}
  ): Promise<ProcessedImage> {
    // Implementation of image processing
    const outputPath = path.join(
      os.tmpdir(),
      `${Date.now()}_${path.basename(inputPath)}.webp`
    );

    // Create a temporary file that will be cleaned up
    const tempFile: TempFile = {
      path: outputPath,
      filename: path.basename(outputPath),
      cleanup: async () => {
        try {
          await fs.promises.unlink(outputPath);
        } catch (error) {
          console.error("Failed to cleanup temp file:", error);
        }
      },
    };

    // Process the image and save to temp file
    // ... image processing implementation ...

    return {
      webpPath: tempFile,
      s3WebpPath: outputPath,
      uploadPromise: Promise.resolve(),
    };
  }

  public async bufferToDataUrl(
    buffer: Buffer,
    mimeType: string = "image/webp"
  ): Promise<string> {
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  async processWebp(
    inputPath: string,
    options: ProcessingOptions = {}
  ): Promise<ProcessedImage> {
    const cacheKey = this.assetCache.generateCacheKey("webp" as AssetType, {
      path: inputPath,
      ...options,
    });

    const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);

    if (cachedAsset) {
      const tempFile: TempFile = {
        path: cachedAsset.path,
        filename: path.basename(cachedAsset.path),
        cleanup: async () => {
          /* No cleanup needed for cached files */
        },
      };

      return {
        webpPath: tempFile,
        s3WebpPath: cachedAsset.path,
        uploadPromise: Promise.resolve(),
      };
    }

    // Process the image
    const processedImage = await this.processImage(inputPath, options);

    // Cache the result
    await this.assetCache.cacheAsset({
      type: "webp" as AssetType,
      path: processedImage.s3WebpPath,
      cacheKey,
      metadata: {
        timestamp: new Date(),
        settings: options,
        hash: this.assetCache.generateHash(processedImage.s3WebpPath),
      },
    });

    return processedImage;
  }
}

// Export singleton instance
export const imageProcessor = new ImageProcessor();
