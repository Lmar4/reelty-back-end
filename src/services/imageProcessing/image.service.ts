import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { s3Service } from "../storage/s3.service";
import { tempFileManager, TempFile } from "../storage/temp-file.service";
import * as path from "path";
import { Readable } from "stream";

const prisma = new PrismaClient();

export interface ProcessedImage {
  webpPath: TempFile;
  s3WebpPath: string;
  uploadPromise: Promise<void>;
}

export interface ImageValidation {
  isValid: boolean;
  error?: string;
}

export interface ProcessingOptions {
  quality?: number;
  width?: number;
  height?: number;
  fit?: keyof sharp.FitEnum;
  effort?: number;
  smartSubsample?: boolean;
  mixed?: boolean;
}

export class ImageProcessor {
  private readonly DEFAULT_BATCH_SIZE = 3;
  private readonly DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MB
  private readonly MAX_RETRIES = 3;

  constructor() {}

  private cleanUrl(url: string): string {
    // Remove query parameters from URL
    return url.split("?")[0];
  }

  private getFilenameFromUrl(url: string): string {
    const cleanUrl = this.cleanUrl(url);
    return path.basename(cleanUrl);
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    retries: number = this.MAX_RETRIES
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === retries - 1) throw error;
        console.warn(`Retry attempt ${i + 1} of ${retries}`, {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, i) * 1000)
        );
      }
    }
    throw new Error("Retry operation failed");
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
    const batchSize = this.DEFAULT_BATCH_SIZE;

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

  public async processImage(s3Path: string): Promise<ProcessedImage> {
    console.log("Starting image processing:", { s3Path });

    // Parse the S3 URL and create temp paths
    const { key: originalKey } = s3Service.parseUrl(s3Path);
    const webpKey = originalKey.replace(/\.[^.]+$/, ".webp");

    // Create temp files with clean filenames
    const originalFile = await tempFileManager.createTempPath(
      this.getFilenameFromUrl(originalKey),
      "original"
    );
    const webpFile = await tempFileManager.createTempPath(
      this.getFilenameFromUrl(webpKey),
      "webp"
    );

    try {
      // Check if WebP version exists in database
      const existingPhoto = await prisma.photo.findFirst({
        where: { filePath: originalKey, processedFilePath: { not: null } },
      });

      if (existingPhoto?.processedFilePath) {
        console.log("Found existing WebP in database:", {
          processedFilePath: existingPhoto.processedFilePath,
        });
        // Download existing WebP from S3
        const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${existingPhoto.processedFilePath}`;
        const webpBuffer = await this.downloadInChunks(s3WebpPath);
        await tempFileManager.writeFile(webpFile, webpBuffer);

        return {
          webpPath: webpFile,
          s3WebpPath,
          uploadPromise: Promise.resolve(),
        };
      }

      // Download original image
      console.log("Downloading original from S3:", { s3Path });
      const imageBuffer = await this.downloadInChunks(s3Path);
      await tempFileManager.writeFile(originalFile, imageBuffer);

      // Validate the image
      console.log("Validating image");
      const validation = await this.validateImage(imageBuffer);
      if (!validation.isValid) {
        throw new Error(`Invalid image: ${validation.error}`);
      }

      // Convert to WebP
      console.log("Converting to WebP");
      const webpBuffer = await this.convertToWebP(imageBuffer, {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
        effort: 4,
        smartSubsample: true,
        mixed: true,
      });

      await tempFileManager.writeFile(webpFile, webpBuffer);

      // Prepare S3 upload
      const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${webpKey}`;
      console.log("Preparing to upload WebP:", { webpKey });

      // Create upload promise
      const uploadPromise = this.retryOperation(() =>
        s3Service
          .uploadFile(webpBuffer, webpKey, "image/webp")
          .then(async () => {
            await prisma.photo.updateMany({
              where: { filePath: originalKey },
              data: { processedFilePath: webpKey },
            });
            console.log("Updated photo record with WebP path:", {
              original: originalKey,
              webp: webpKey,
            });
          })
      );

      return {
        webpPath: webpFile,
        s3WebpPath,
        uploadPromise,
      };
    } catch (error) {
      // Cleanup temp files
      await Promise.all([originalFile.cleanup(), webpFile.cleanup()]);
      throw error;
    }
  }
}

// Export singleton instance
export const imageProcessor = new ImageProcessor();
