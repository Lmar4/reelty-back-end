import { VisionProcessor } from "./visionProcessor";
import * as path from "path";
import * as fs from "fs";
import { s3VideoService } from "../video/s3-video.service";
import { AssetCacheService } from "../cache/assetCache";

interface ProcessingResult {
  originalImage: string;
  webpPath?: string;
  s3Url?: string;
  publicUrl?: string;
  dimensions?: {
    width: number;
    height: number;
  };
  size?: number;
  success: boolean;
  error?: string;
}

async function testWebPProcessing() {
  // Create temp directory if it doesn't exist
  const tempDir = path.join(__dirname, "../../../temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Initialize services
  const visionProcessor = new VisionProcessor();
  const assetCache = AssetCacheService.getInstance();

  // Get all test images
  const testImagesDir = path.join(
    __dirname,
    "../../../public/assets/testing_image"
  );
  if (!fs.existsSync(testImagesDir)) {
    throw new Error(`Test images directory not found: ${testImagesDir}`);
  }

  const images = fs
    .readdirSync(testImagesDir)
    .filter((file) => file.endsWith(".jpg"))
    .map((file) => ({
      path: path.join(testImagesDir, file),
    }));

  if (images.length === 0) {
    throw new Error("No test images found");
  }

  console.log(
    "Starting WebP processing test with images:",
    images.map((img) => path.basename(img.path))
  );

  const results: ProcessingResult[] = [];
  const s3Urls: string[] = [];

  // Process each image
  for (const image of images) {
    try {
      const outputPath = path.join(
        tempDir,
        `${path.basename(image.path, ".jpg")}.webp`
      );

      console.log(`Processing ${path.basename(image.path)}...`);

      // Convert to WebP
      await visionProcessor.convertToWebP(image.path, outputPath, {
        width: 768,
        height: 1280,
        quality: 90,
        fit: "cover",
      });

      // Validate the output
      const stats = await fs.promises.stat(outputPath);
      const dimensions = await visionProcessor.getImageDimensions(outputPath);

      // Validate dimensions
      if (dimensions.width !== 768 || dimensions.height !== 1280) {
        throw new Error(
          `Invalid dimensions: ${dimensions.width}x${dimensions.height}`
        );
      }

      // Validate file size (should be reasonable for a WebP)
      if (stats.size < 1000) {
        throw new Error(`File too small: ${stats.size} bytes`);
      }

      // Upload to S3
      const s3Key = `test-webp/${path.basename(outputPath)}`;
      const fileBuffer = await fs.promises.readFile(outputPath);
      const s3Url = await s3VideoService.uploadFile(fileBuffer, s3Key);

      // Get public URL for Runway
      const { bucket, key } = s3VideoService.parseS3Path(
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );
      const publicUrl = s3VideoService.getPublicUrl(key, bucket);

      results.push({
        originalImage: path.basename(image.path),
        webpPath: outputPath,
        s3Url,
        publicUrl,
        dimensions,
        size: stats.size,
        success: true,
      });

      s3Urls.push(publicUrl);

      console.log(`Successfully processed ${path.basename(image.path)}:`, {
        dimensions,
        size: stats.size,
        s3Url,
        publicUrl,
      });
    } catch (error) {
      console.error(`Failed to process ${path.basename(image.path)}:`, error);
      results.push({
        originalImage: path.basename(image.path),
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Log results
  console.log("\nWebP processing completed:", {
    totalImages: images.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });

  // Print full paths and URLs for successful conversions
  console.log("\nSuccessful conversions details:");
  results.forEach((r) => {
    if (r.success && r.dimensions) {
      console.log(`\nImage: ${r.originalImage}`);
      console.log(`Original: ${path.join(testImagesDir, r.originalImage)}`);
      console.log(`WebP: ${r.webpPath}`);
      console.log(`S3 URL: ${r.s3Url}`);
      console.log(`Public URL for Runway: ${r.publicUrl}`);
      console.log(`Dimensions: ${r.dimensions.width}x${r.dimensions.height}`);
      console.log(`Size: ${r.size} bytes`);
    }
  });

  // Print URLs ready for Runway
  console.log("\nURLs ready for Runway API:");
  s3Urls.forEach((url, index) => {
    console.log(`${index + 1}. ${url}`);
  });
}

// Run the test
testWebPProcessing().catch(console.error);
