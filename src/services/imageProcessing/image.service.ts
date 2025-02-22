import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { Readable } from "stream";
import { v4 as uuidv4 } from "uuid";
import { AssetCacheService, AssetType } from "../cache/assetCache";
import { s3VideoService } from "../video/s3-video.service";
import { TempFile } from "../storage/temp-file.service";
import { logger } from "../../utils/logger";

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

  private validateS3Url(url: string): boolean {
    // Validate S3 URL format
    const s3Regex = /^s3:\/\/[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_./]+$/;
    const httpsRegex =
      /^https:\/\/[a-zA-Z0-9-_.]+\.s3\.[a-zA-Z0-9-_.]+\.amazonaws\.com\/[a-zA-Z0-9-_./]+$/;
    return s3Regex.test(url) || httpsRegex.test(url);
  }

  private async validateS3Path(path: string): Promise<boolean> {
    try {
      if (!this.validateS3Url(path)) {
        logger.warn("Invalid S3 URL format", { path });
        return false;
      }

      // Extract bucket and key from URL
      let bucket: string;
      let key: string;

      if (path.startsWith("s3://")) {
        const parts = path.slice(5).split("/");
        bucket = parts[0];
        key = parts.slice(1).join("/");
      } else {
        const url = new URL(path);
        bucket = url.hostname.split(".")[0];
        key = decodeURIComponent(url.pathname.substring(1));
      }

      // Check if file exists in S3
      const exists = await s3VideoService.checkFileExists(bucket, key);
      if (!exists) {
        logger.warn("S3 file not found", { path, bucket, key });
        return false;
      }

      return true;
    } catch (error) {
      logger.error("Failed to validate S3 path", {
        path,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  public async processBatch(s3Paths: string[]): Promise<ProcessedImage[]> {
    if (!Array.isArray(s3Paths) || s3Paths.length === 0) {
      throw new Error("Invalid input: s3Paths must be a non-empty array");
    }

    logger.info("Starting batch processing validation", {
      count: s3Paths.length,
      paths: s3Paths,
    });

    // Validate all paths first
    const validationResults = await Promise.all(
      s3Paths.map(async (path) => {
        const isValid = await this.validateS3Path(path);
        return { path, isValid };
      })
    );

    const invalidPaths = validationResults.filter((r) => !r.isValid);
    if (invalidPaths.length > 0) {
      throw new Error(
        `Invalid S3 paths: ${invalidPaths.map((p) => p.path).join(", ")}`
      );
    }

    logger.info("All paths validated successfully", {
      count: s3Paths.length,
    });

    const results: ProcessedImage[] = [];
    const batchSize = MAX_CONCURRENT_OPERATIONS;

    for (let i = 0; i < s3Paths.length; i += batchSize) {
      const batch = s3Paths.slice(i, i + batchSize);
      logger.info(`Processing batch ${i / batchSize + 1}:`, {
        size: batch.length,
        remaining: s3Paths.length - (i + batch.length),
      });

      try {
        const batchResults = await Promise.all(
          batch.map((path) => this.processImage(path))
        );
        results.push(...batchResults);

        // Add a small delay between batches to prevent rate limiting
        if (i + batchSize < s3Paths.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        logger.error("Batch processing failed", {
          batchStart: i,
          batchSize,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      }
    }

    return results;
  }

  private async downloadInChunks(s3Path: string): Promise<Buffer> {
    return this.retryOperation(async () => {
      try {
        // Validate path again before download
        if (!(await this.validateS3Path(s3Path))) {
          throw new Error(`Invalid or inaccessible S3 path: ${s3Path}`);
        }

        const chunks: Buffer[] = [];
        const stream = await s3VideoService.downloadVideo(s3Path, "temp/image");

        // If we already have a Buffer, return it directly
        if (Buffer.isBuffer(stream)) {
          return stream;
        }

        // Otherwise, handle as a stream
        return new Promise<Buffer>((resolve, reject) => {
          const readable = stream as unknown as Readable;
          readable.on("data", (chunk: Buffer) => chunks.push(chunk));
          readable.on("end", () => resolve(Buffer.concat(chunks)));
          readable.on("error", (error) => {
            logger.error("Stream download failed", {
              path: s3Path,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            reject(error);
          });
        });
      } catch (error) {
        logger.error("Failed to download file", {
          path: s3Path,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      }
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
      await s3VideoService.uploadFile(fileBuffer, s3Key);
      const s3Url = s3VideoService.getPublicUrl(s3Key);

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
      logger.info("Cache hit for WebP, skipping original image download:", {
        inputPath,
        cachedPath: cachedAsset.path,
      });

      // Verify cached S3 URL is still valid
      const isValid = await this.validateS3Path(cachedAsset.path);
      if (isValid) {
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
      } else {
        logger.warn("Cached S3 URL is no longer valid, reprocessing:", {
          inputPath,
          cachedPath: cachedAsset.path,
        });
        await this.assetCache.invalidateAsset(cacheKey);
      }
    }

    // Only process the original image if no cached version exists or cache is invalid
    logger.info("Processing original image:", inputPath);
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

    // Verify the processed image was uploaded successfully
    const isValid = await this.validateS3Path(processedImage.s3WebpPath);
    if (!isValid) {
      throw new Error(
        `Failed to verify processed image upload: ${processedImage.s3WebpPath}`
      );
    }

    return processedImage;
  }
}

// Export singleton instance
export const imageProcessor = new ImageProcessor();
