import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { s3Service } from "../storage/s3.service";
import { tempFileManager, TempFile } from "../storage/temp-file.service";

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

export class ImageProcessor {
  constructor() {}

  public async validateImage(buffer: Buffer): Promise<ImageValidation> {
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
  }

  public async convertToWebP(
    buffer: Buffer,
    options: {
      quality?: number;
      width?: number;
      height?: number;
      fit?: keyof sharp.FitEnum;
    } = {}
  ): Promise<Buffer> {
    const image = sharp(buffer);

    // Apply resizing if dimensions are provided
    if (options.width || options.height) {
      image.resize(options.width, options.height, {
        fit: options.fit || "contain",
        withoutEnlargement: true,
      });
    }

    // Convert to WebP with specified quality
    return image
      .webp({
        quality: options.quality || 80,
        effort: 4, // Medium compression effort
      })
      .toBuffer();
  }

  public async processImage(s3Path: string): Promise<ProcessedImage> {
    console.log("Starting image processing:", { s3Path });

    // Parse the S3 URL and create temp paths
    const { key: originalKey } = s3Service.parseUrl(s3Path);
    const webpKey = originalKey.replace(/\.[^.]+$/, ".webp");

    // Create temp files
    const originalFile = await tempFileManager.createTempPath(
      originalKey,
      "original"
    );
    const webpFile = await tempFileManager.createTempPath(webpKey, "webp");

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
        const webpBuffer = await s3Service.downloadFile(s3WebpPath);
        await tempFileManager.writeFile(webpFile, webpBuffer);

        return {
          webpPath: webpFile,
          s3WebpPath,
          uploadPromise: Promise.resolve(),
        };
      }

      // Download original image
      console.log("Downloading original from S3:", { s3Path });
      const imageBuffer = await s3Service.downloadFile(s3Path);
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
      });

      await tempFileManager.writeFile(webpFile, webpBuffer);

      // Prepare S3 upload
      const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${webpKey}`;
      console.log("Preparing to upload WebP:", { webpKey });

      // Create upload promise
      const uploadPromise = s3Service
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
        });

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
