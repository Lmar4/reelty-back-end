import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { Readable } from "stream";
import { v4 as uuidv4 } from "uuid";
import { AssetCacheService, AssetType } from "../cache/assetCache";
import { s3Service } from "../storage/s3.service";
import { TempFile } from "../storage/temp-file.service";

export const MAX_CONCURRENT_OPERATIONS = 10;
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
  private readonly DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB
  private readonly MAX_RETRIES = 3;
  private assetCache: AssetCacheService;

  constructor() {
    this.assetCache = AssetCacheService.getInstance();
  }

  private generateUniqueFilename(originalName: string): string {
    // Clean the original name - remove all extensions and special chars
    const cleanName = originalName
      .toLowerCase()
      .split(".")
      .slice(0, -1) // Remove all extensions
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""); // Remove leading/trailing dashes

    // Get first segment of UUID for uniqueness
    const uniqueId = uuidv4().split("-")[0];

    // Combine unique ID with cleaned name
    return `${uniqueId}-${cleanName}.webp`;
  }

  private async retryOperation<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === this.MAX_RETRIES) break;

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  public async validateImage(buffer: Buffer): Promise<ImageValidation> {
    return this.retryOperation(async () => {
      try {
        const image = sharp(buffer);
        const metadata = await image.metadata();

        if (
          !metadata.format ||
          !["jpeg", "jpg", "png", "webp"].includes(metadata.format)
        ) {
          return {
            isValid: false,
            error: `Unsupported image format: ${metadata.format}`,
          };
        }

        if (!metadata.width || !metadata.height) {
          return {
            isValid: false,
            error: "Invalid image dimensions",
          };
        }

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
        limitInputPixels: Math.pow(2, 24),
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
    const batchSize = MAX_CONCURRENT_OPERATIONS;

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

  private async downloadInChunks(s3Path: string): Promise<Buffer> {
    return this.retryOperation(async () => {
      const chunks: Buffer[] = [];
      const stream = await s3Service.downloadFile(s3Path, "temp/image");

      // If we already have a Buffer, return it directly
      if (Buffer.isBuffer(stream)) {
        return stream;
      }

      // Otherwise, handle as a stream
      return new Promise<Buffer>((resolve, reject) => {
        const readable = stream as unknown as Readable;
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
    console.log("Starting image processing:", { inputPath });

    const outputPath = path.join(
      os.tmpdir(),
      this.generateUniqueFilename(path.basename(inputPath))
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

    try {
      // Download and process the image
      let imageBuffer: Buffer;
      if (inputPath.startsWith("http") || inputPath.startsWith("s3://")) {
        console.log("Downloading image from remote source:", inputPath);
        imageBuffer = await this.downloadInChunks(inputPath);
      } else {
        console.log("Reading image from local path:", inputPath);
        imageBuffer = await fs.promises.readFile(inputPath);
      }

      // Convert to WebP
      console.log("Converting image to WebP:", { outputPath });
      const webpBuffer = await this.convertToWebP(imageBuffer, options);
      await fs.promises.writeFile(outputPath, webpBuffer);

      // Upload to S3
      const s3Key = `processed/${path.basename(outputPath)}`;
      console.log("Uploading WebP to S3:", { s3Key });
      const fileBuffer = await fs.promises.readFile(outputPath);
      await s3Service.uploadFile(fileBuffer, s3Key);
      const s3Url = s3Service.getPublicUrl(s3Key);

      // Cleanup temp file since we have it in S3
      await tempFile.cleanup();

      return {
        webpPath: { ...tempFile, path: s3Url },
        s3WebpPath: s3Url,
        uploadPromise: Promise.resolve(),
      };
    } catch (error) {
      console.error("Failed to process image:", {
        inputPath,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      await tempFile.cleanup();
      throw error;
    }
  }

  public async bufferToDataUrl(
    buffer: Buffer,
    mimeType: string = "image/webp"
  ): Promise<string> {
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  public async processWebp(
    inputPath: string,
    options: ProcessingOptions = {}
  ): Promise<ProcessedImage> {
    const cacheKey = this.assetCache.generateCacheKey("webp" as AssetType, {
      path: inputPath,
      ...options,
    });

    // Check cache first
    const cachedAsset = await this.assetCache.getCachedAsset(cacheKey);
    if (cachedAsset) {
      console.log("Cache hit for WebP, skipping original image download:", {
        inputPath,
        cachedAsset,
      });

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

    // Only process the original image if no cached version exists
    console.log("Cache miss for WebP, processing original image:", inputPath);
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
