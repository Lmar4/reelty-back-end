import { promises as fsPromises } from "fs";
import sharp from "sharp";
import { logger } from "../../utils/logger.js";
import { Logger } from "winston";

export interface CropCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageStats {
  edges: number;
  contrast: number;
  brightness: number;
}

export interface ImageOptimizationOptions {
  quality?: number;
  width?: number;
  height?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
}

export class VisionProcessor {
  private logger: Logger;

  constructor() {
    this.logger = logger;
  }

  private async validateImage(imagePath: string): Promise<void> {
    try {
      await fsPromises.access(imagePath);
    } catch (error) {
      throw new Error(`Image not found: ${imagePath}`);
    }
  }

  private async calculateImageStats(
    imagePath: string,
    region: CropCoordinates
  ): Promise<ImageStats> {
    this.logger.info("Calculating stats for region", { region });

    try {
      // Use a fresh sharp instance to avoid state issues
      const freshImage = sharp(imagePath);

      // Validate region dimensions before extraction
      const metadata = await freshImage.metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error("Unable to get image dimensions for stats calculation");
      }

      // Double check region bounds
      if (
        region.x < 0 ||
        region.y < 0 ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x + region.width > metadata.width ||
        region.y + region.height > metadata.height
      ) {
        throw new Error("Invalid region dimensions for stats calculation");
      }

      const { data, info } = await freshImage
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const edges = this.calculateEdgeDensity(data, info.width, info.height);
      const { contrast, brightness } =
        this.calculateContrastAndBrightness(data);

      this.logger.info("Stats calculated successfully", {
        edges,
        contrast,
        brightness,
        region,
        dimensions: { width: info.width, height: info.height },
      });

      return { edges, contrast, brightness };
    } catch (error) {
      this.logger.error("Failed to calculate image stats", {
        error: error instanceof Error ? error.message : "Unknown error",
        region,
        imagePath,
      });
      throw error;
    }
  }

  private calculateEdgeDensity(
    data: Buffer,
    width: number,
    height: number
  ): number {
    let edgeSum = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const gx = data[idx - 1] - data[idx + 1];
        const gy = data[idx - width] - data[idx + width];
        edgeSum += Math.sqrt(gx * gx + gy * gy);
      }
    }

    return edgeSum / (width * height);
  }

  private calculateContrastAndBrightness(data: Buffer): {
    contrast: number;
    brightness: number;
  } {
    let min = 255;
    let max = 0;
    let sum = 0;

    for (const pixel of data) {
      min = Math.min(min, pixel);
      max = Math.max(max, pixel);
      sum += pixel;
    }

    return {
      contrast: max - min,
      brightness: sum / data.length,
    };
  }

  async analyzeImageForCrop(input: string | Buffer): Promise<CropCoordinates> {
    try {
      let image: sharp.Sharp;

      if (Buffer.isBuffer(input)) {
        image = sharp(input);
      } else {
        await this.validateImage(input);
        image = sharp(input);
      }

      const metadata = await image.metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error("Unable to get image dimensions");
      }

      this.logger.info("Starting image analysis", {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      });

      const targetRatio = 9 / 16;
      const currentRatio = metadata.width / metadata.height;

      let cropWidth: number;
      let cropHeight: number;

      if (currentRatio > targetRatio) {
        cropWidth = Math.round(metadata.height * targetRatio);
        cropHeight = metadata.height;
      } else {
        cropWidth = metadata.width;
        cropHeight = Math.round(metadata.width / targetRatio);
      }

      // Ensure crop dimensions don't exceed image
      cropWidth = Math.min(cropWidth, metadata.width);
      cropHeight = Math.min(cropHeight, metadata.height);

      this.logger.debug("Calculated crop dimensions", {
        cropWidth,
        cropHeight,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
      });

      // Generate regions with more conservative steps
      const regions: CropCoordinates[] = [];
      const horizontalSteps = 3; // Reduced from 5
      const verticalSteps = 2; // Reduced from 3

      const horizontalStepSize = Math.max(
        1,
        Math.floor((metadata.width - cropWidth) / horizontalSteps)
      );
      const verticalStepSize = Math.max(
        1,
        Math.floor((metadata.height - cropHeight) / verticalSteps)
      );

      this.logger.debug("Region generation parameters", {
        horizontalStepSize,
        verticalStepSize,
        horizontalSteps,
        verticalSteps,
      });

      // Generate regions by scanning both horizontally and vertically
      for (
        let y = 0;
        y <= metadata.height - cropHeight;
        y += verticalStepSize
      ) {
        for (
          let x = 0;
          x <= metadata.width - cropWidth;
          x += horizontalStepSize
        ) {
          const region = {
            x,
            y,
            width: cropWidth,
            height: cropHeight,
          };

          // Validate region before adding
          if (
            x >= 0 &&
            y >= 0 &&
            region.width > 0 &&
            region.height > 0 &&
            x + region.width <= metadata.width &&
            y + region.height <= metadata.height
          ) {
            regions.push(region);
          }
        }
      }

      this.logger.info("Generated regions for analysis", {
        regionCount: regions.length,
      });

      // Analyze each region with error handling
      const analyses = await Promise.allSettled(
        regions.map(async (region) => {
          try {
            // Extract region
            const { data, info } = await image
              .extract({
                left: region.x,
                top: region.y,
                width: region.width,
                height: region.height,
              })
              .greyscale()
              .raw()
              .toBuffer({ resolveWithObject: true });

            const edges = this.calculateEdgeDensity(
              data,
              info.width,
              info.height
            );
            const { contrast, brightness } =
              this.calculateContrastAndBrightness(data);

            return { edges, contrast, brightness };
          } catch (error) {
            throw new Error(
              `Failed to analyze region: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            );
          }
        })
      );

      // Filter out rejected promises and get valid results
      const validAnalyses = analyses
        .filter(
          (result): result is PromiseFulfilledResult<ImageStats> =>
            result.status === "fulfilled"
        )
        .map((result) => result.value);

      if (validAnalyses.length === 0) {
        throw new Error("No valid regions could be analyzed");
      }

      // Find region with highest combined score
      let bestScore = -1;
      let bestRegion = regions[0];

      validAnalyses.forEach((stats, index) => {
        const score =
          stats.edges * 0.5 + stats.contrast * 0.3 + stats.brightness * 0.2;

        if (score > bestScore) {
          bestScore = score;
          bestRegion = regions[index];
        }
      });

      // Final validation of best region
      if (
        bestRegion.x < 0 ||
        bestRegion.y < 0 ||
        bestRegion.width <= 0 ||
        bestRegion.height <= 0 ||
        bestRegion.x + bestRegion.width > metadata.width ||
        bestRegion.y + bestRegion.height > metadata.height
      ) {
        this.logger.error("Invalid best region coordinates", {
          bestRegion,
          metadata,
        });

        // Fallback to center crop
        bestRegion = {
          x: Math.max(0, Math.floor((metadata.width - cropWidth) / 2)),
          y: Math.max(0, Math.floor((metadata.height - cropHeight) / 2)),
          width: cropWidth,
          height: cropHeight,
        };

        this.logger.info("Using fallback center crop", { bestRegion });
      }

      this.logger.debug("Final crop coordinates", {
        bestRegion,
        score: bestScore,
      });

      return bestRegion;
    } catch (error) {
      this.logger.error("Failed to analyze image", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error(
        `Failed to analyze image: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Gets the dimensions of an image
   * @param imagePath Path to the image file
   * @returns Promise with the width and height of the image
   */
  async getImageDimensions(
    imagePath: string
  ): Promise<{ width: number; height: number }> {
    try {
      await this.validateImage(imagePath);
      const metadata = await sharp(imagePath).metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error("Unable to get image dimensions");
      }

      return {
        width: metadata.width,
        height: metadata.height,
      };
    } catch (error) {
      throw new Error(
        `Failed to get image dimensions: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}
