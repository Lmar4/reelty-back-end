import * as fs from "fs";
import { promisify } from "util";
import sharp from "sharp";

const exists = promisify(fs.exists);

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

export class VisionProcessor {
  private async validateImage(imagePath: string): Promise<void> {
    if (!(await exists(imagePath))) {
      throw new Error(`Image not found: ${imagePath}`);
    }
  }

  private async calculateImageStats(
    image: sharp.Sharp,
    region: CropCoordinates
  ): Promise<ImageStats> {
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

    // Calculate edge density using Sobel operator
    const edges = this.calculateEdgeDensity(data, info.width, info.height);

    // Calculate contrast and brightness
    const { contrast, brightness } = this.calculateContrastAndBrightness(data);

    return { edges, contrast, brightness };
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

  async analyzeImageForCrop(imagePath: string): Promise<CropCoordinates> {
    try {
      await this.validateImage(imagePath);

      const image = sharp(imagePath);
      const metadata = await image.metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error("Unable to get image dimensions");
      }

      // Target 9:16 aspect ratio
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

      // Analyze multiple regions to find optimal crop
      const regions: CropCoordinates[] = [];
      const steps = 5;
      const stepSize = Math.floor((metadata.width - cropWidth) / steps);

      for (let x = 0; x <= metadata.width - cropWidth; x += stepSize) {
        regions.push({
          x,
          y: Math.floor((metadata.height - cropHeight) / 2),
          width: cropWidth,
          height: cropHeight,
        });
      }

      // Analyze each region
      const analyses = await Promise.all(
        regions.map((region) => this.calculateImageStats(image, region))
      );

      // Find region with highest combined score
      let bestScore = -1;
      let bestRegion = regions[0];

      analyses.forEach((stats, index) => {
        const score =
          stats.edges * 0.5 + stats.contrast * 0.3 + stats.brightness * 0.2;

        if (score > bestScore) {
          bestScore = score;
          bestRegion = regions[index];
        }
      });

      return bestRegion;
    } catch (error) {
      throw new Error(
        `Failed to analyze image: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
}
