import { promises as fsPromises } from "fs";
import sharp from "sharp";
import path from "path";

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
  private async validateImage(imagePath: string): Promise<void> {
    try {
      await fsPromises.access(imagePath);
    } catch (error) {
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

      // Modified region generation to consider both horizontal and vertical positions
      const regions: CropCoordinates[] = [];
      const horizontalSteps = 5;
      const verticalSteps = 3; // Add vertical steps

      const horizontalStepSize = Math.max(
        1,
        Math.floor((metadata.width - cropWidth) / horizontalSteps)
      );
      const verticalStepSize = Math.max(
        1,
        Math.floor((metadata.height - cropHeight) / verticalSteps)
      );

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
          regions.push({
            x,
            y,
            width: cropWidth,
            height: cropHeight,
          });
        }
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
        `Failed to analyze image: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Converts an image to WebP format with optimization
   * @param inputPath Path to the input image
   * @param outputPath Optional custom output path. If not provided, will use same name with .webp extension
   * @param options Optimization options for the conversion
   * @returns Path to the converted WebP image
   */
  async convertToWebP(
    inputPath: string,
    outputPath?: string,
    options: ImageOptimizationOptions = {}
  ): Promise<string> {
    try {
      await this.validateImage(inputPath);

      const finalOutputPath = outputPath || this.generateWebPPath(inputPath);

      let imageProcess = sharp(inputPath);

      // Apply resizing if dimensions are provided
      if (options.width || options.height) {
        imageProcess = imageProcess.resize({
          width: options.width,
          height: options.height,
          fit: options.fit || "cover",
          withoutEnlargement: true,
        });
      }

      // Convert to WebP with quality setting
      await imageProcess
        .webp({
          quality: options.quality || 80,
          effort: 6, // Higher compression effort
        })
        .toFile(finalOutputPath);

      return finalOutputPath;
    } catch (error) {
      throw new Error(
        `Failed to convert image to WebP: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Batch converts multiple images to WebP format
   * @param inputPaths Array of paths to input images
   * @param options Optimization options for the conversion
   * @returns Array of paths to the converted WebP images
   */
  async batchConvertToWebP(
    inputPaths: string[],
    options: ImageOptimizationOptions = {}
  ): Promise<string[]> {
    try {
      const conversionPromises = inputPaths.map((inputPath) =>
        this.convertToWebP(inputPath, undefined, options)
      );

      return await Promise.all(conversionPromises);
    } catch (error) {
      throw new Error(
        `Failed to batch convert images to WebP: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private generateWebPPath(inputPath: string): string {
    const parsedPath = path.parse(inputPath);
    return path.join(parsedPath.dir, `${parsedPath.name}.webp`);
  }

  async convertBufferToWebP(
    buffer: Buffer,
    options: {
      quality?: number;
      width?: number;
      height?: number;
      fit?: "cover" | "contain" | "fill" | "inside" | "outside";
    }
  ): Promise<Buffer> {
    let imageProcess = sharp(buffer);

    // Apply resizing if dimensions are provided
    if (options.width || options.height) {
      imageProcess = imageProcess.resize({
        width: options.width,
        height: options.height,
        fit: options.fit || "cover",
        withoutEnlargement: true,
      });
    }

    // Convert to WebP with quality setting
    return imageProcess
      .webp({
        quality: options.quality || 80,
        effort: 6, // Higher compression effort
      })
      .toBuffer();
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
