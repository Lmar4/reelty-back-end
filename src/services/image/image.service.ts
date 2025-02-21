import { PrismaClient } from "@prisma/client";
import { s3Service } from "../storage/s3.service";
import { assetCacheService } from "../cache/asset-cache.service";
import { logger } from "../../utils/logger";

export class ImageService {
  private static instance: ImageService;
  private readonly prisma: PrismaClient;

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): ImageService {
    if (!ImageService.instance) {
      ImageService.instance = new ImageService();
    }
    return ImageService.instance;
  }

  async getImageUrl(imageUrl: string): Promise<string> {
    try {
      const cacheKey = `image-${imageUrl}`;

      // Check cache first
      const cachedPath = await assetCacheService.getCachedAsset(cacheKey);
      if (cachedPath) {
        return cachedPath;
      }

      // Parse the original URL to get filename
      const { key } = s3Service.parseS3Url(imageUrl);

      // Cache the S3 URL
      await assetCacheService.cacheAsset(imageUrl, cacheKey, {
        type: "webp",
        settings: {},
      });

      return imageUrl;
    } catch (error) {
      logger.error("Failed to get image URL", {
        imageUrl,
        error,
      });
      throw error;
    }
  }

  async getMultipleImageUrls(imageUrls: string[]): Promise<string[]> {
    return Promise.all(imageUrls.map((url) => this.getImageUrl(url)));
  }
}

export const imageService = ImageService.getInstance();
