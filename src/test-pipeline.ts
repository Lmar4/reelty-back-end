import { imageProcessor } from "./services/imageProcessing/image.service";
import { runwayService } from "./services/video/runway.service";
import { s3VideoService } from "./services/video/s3-video.service";
import {
  reelTemplates,
} from "./services/imageProcessing/templates/types";
import { MapCapture } from "./services/imageProcessing/mapCapture";
import * as path from "path";
import * as fs from "fs/promises";

async function testWebPConversion() {
  console.log("🚀 Testing WebP Conversion Stage...");

  const testImagesDir = path.join(__dirname, "../public/assets/testing_image");
  const outputDir = path.join(__dirname, "../temp/test-output");

  try {
    // Create output directory if it doesn't exist
    await fs.mkdir(outputDir, { recursive: true });

    // Get all test images
    const files = await fs.readdir(testImagesDir);
    const imagePaths = files
      .filter((file) => file.endsWith(".jpg"))
      .map((file) => path.join(testImagesDir, file));

    console.log(`Found ${imagePaths.length} test images`);

    // Process each image
    const results = await Promise.all(
      imagePaths.map(async (imagePath) => {
        console.log(`Processing ${path.basename(imagePath)}...`);
        try {
          // Read the image file
          const imageBuffer = await fs.readFile(imagePath);

          // Convert to WebP
          const webpBuffer = await imageProcessor.convertToWebP(imageBuffer, {
            width: 1080,
            height: 1920,
            quality: 80,
            fit: "cover",
          });

          // Save WebP to our test output directory
          const outputWebP = path.join(
            outputDir,
            `${path.basename(imagePath)}.webp`
          );
          await fs.writeFile(outputWebP, webpBuffer);

          // Upload WebP to S3
          const s3Key = `test-assets/webp/${path.basename(outputWebP)}`;
          const s3Path = `s3://${process.env.AWS_BUCKET}/${s3Key}`;

          console.log(`Uploading to S3: ${s3Path}`);
          await s3VideoService.uploadVideo(outputWebP, s3Path);

          console.log(
            `✅ Successfully processed and uploaded ${path.basename(imagePath)}`
          );
          console.log(`S3 Path: ${s3Path}`);

          return {
            localPath: outputWebP,
            s3Path,
          };
        } catch (error) {
          console.error(
            `❌ Failed to process ${path.basename(imagePath)}:`,
            error
          );
          throw error;
        }
      })
    );

    console.log("✅ WebP Conversion Stage Complete!");
    console.log(
      "Processed Files:",
      results.map((r) => r.s3Path)
    );

    return results;
  } catch (error) {
    console.error("❌ WebP Conversion Stage Failed:", error);
    throw error;
  }
}

async function testRunwayGeneration(webpFiles: { s3Path: string }[]) {
  console.log("\n🚀 Testing Runway Video Generation Stage...");

  try {
    // Process each WebP file with Runway
    const results = await Promise.all(
      webpFiles.map(async (file, index) => {
        const { bucket, key } = s3VideoService.parseS3Path(file.s3Path);
        const publicUrl = s3VideoService.getPublicUrl(bucket, key);

        console.log(`Processing ${path.basename(file.s3Path)}...`);
        console.log(`Using public URL: ${publicUrl}`);

        try {
          const videoPath = await runwayService.generateVideo(publicUrl, index);

          console.log(
            `✅ Successfully generated video for ${path.basename(file.s3Path)}`
          );
          console.log(`Output: ${videoPath}`);

          return videoPath;
        } catch (error) {
          console.error(
            `❌ Failed to generate video for ${path.basename(file.s3Path)}:`,
            error
          );
          throw error;
        }
      })
    );

    console.log("✅ Runway Video Generation Stage Complete!");
    console.log("Generated Videos:", results);

    return results;
  } catch (error) {
    console.error("❌ Runway Video Generation Stage Failed:", error);
    throw error;
  }
}

async function testTemplateProcessing(runwayOutputPaths: string[]) {
  console.log("\nTemplate Processing Stage:");
  console.log("-------------------------");

  const templates = [
    "crescendo",
    "wave",
    "storyteller",
    "googlezoomintro",
  ] as const;
  let mapVideoPath: string | undefined;

  // Generate map video for googlezoomintro template
  if (templates.includes("googlezoomintro")) {
    console.log("\nGenerating map video for Google Maps template...");
    const coordinates = {
      lat: -41.3140432,
      lng: -72.9856473,
    };

    try {
      const mapCapture = new MapCapture("./temp");
      const mapFrames = await mapCapture.captureMapAnimation(
        "Klenner 547, Puerto Varas, Chile",
        coordinates
      );

      if (mapFrames && mapFrames.length > 0) {
        mapVideoPath = mapFrames[0];
        console.log("Successfully generated map video:", mapVideoPath);
      }
    } catch (error) {
      console.error("Failed to generate map video:", error);
    }
  }

  // Process each template
  for (const template of templates) {
    console.log(`\nProcessing template: ${template}`);

    try {
      // Analyze available videos
      const availableVideos = runwayOutputPaths.length;
      console.log(`Available videos: ${availableVideos}`);

      // Get template configuration
      const templateConfig = reelTemplates[template];
      console.log(
        `Template sequence length: ${templateConfig.sequence.length}`
      );

      // Adapt sequence for fewer images if needed
      const adaptedSequence = adaptSequenceForImages(
        templateConfig.sequence,
        availableVideos
      );
      console.log(`Adapted sequence length: ${adaptedSequence.length}`);

      // Create template video
      const outputPath = `temp/final/${template}-${Date.now()}.mp4`;
      await ensureDirectoryExists(path.dirname(outputPath));

      // Stitch videos based on template
      await stitchVideos({
        videos: runwayOutputPaths,
        sequence: adaptedSequence,
        outputPath,
        mapVideo: template === "googlezoomintro" ? mapVideoPath : undefined,
      });

      // Upload final video to S3
      const s3Key = `test-assets/final/${path.basename(outputPath)}`;
      await s3VideoService.uploadVideo(
        outputPath,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      console.log(`Successfully processed ${template} template`);
      console.log(`Uploaded to: s3://${process.env.AWS_BUCKET}/${s3Key}`);
    } catch (error) {
      console.error(`Failed to process ${template} template:`, error);
    }
  }

  console.log("\nTemplate Processing Stage: Complete");
}

async function main() {
  try {
    // Test WebP Conversion
    const webpResults = await testWebPConversion();

    // Test Runway Video Generation
    const runwayResults = await testRunwayGeneration(webpResults);

    // Test Template Processing
    const results = await testTemplateProcessing(runwayResults);

    console.log("\nAll tests completed!");
  } catch (error) {
    console.error("Pipeline test failed:", error);
    process.exit(1);
  }
}

// Helper functions
async function ensureDirectoryExists(dir: string): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

function adaptSequenceForImages(
  sequence: any[],
  availableImages: number
): any[] {
  if (availableImages >= sequence.length) return sequence;

  // If we have fewer images than the sequence requires,
  // adapt by repeating images to fill the sequence
  const adapted = [];
  for (let i = 0; i < sequence.length; i++) {
    adapted.push(sequence[i % availableImages]);
  }
  return adapted;
}

async function stitchVideos({
  videos,
  sequence,
  outputPath,
  mapVideo,
}: {
  videos: string[];
  sequence: any[];
  outputPath: string;
  mapVideo?: string;
}): Promise<void> {
  // Use ffmpeg to stitch videos according to sequence
  const ffmpeg = require("fluent-ffmpeg");
  let command = ffmpeg();

  // Add map video if provided
  if (mapVideo) {
    command = command.input(mapVideo);
  }

  // Add all video inputs
  videos.forEach((video) => {
    command = command.input(video);
  });

  // Configure output
  command
    .outputOptions(["-c:v libx264", "-pix_fmt yuv420p"])
    .output(outputPath)
    .on("end", () => console.log("Video stitching complete"))
    .on("error", (err: Error) => {
      throw new Error(`FFmpeg error: ${err.message}`);
    })
    .run();
}

main();
