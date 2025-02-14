import { s3VideoService } from "./services/video/s3-video.service";
import {
  reelTemplates,
} from "./services/imageProcessing/templates/types";
import { MapCapture } from "./services/imageProcessing/mapCapture";
import * as path from "path";
import * as fs from "fs/promises";
import dotenv from "dotenv";
const ffmpeg = require("fluent-ffmpeg");

// Load environment variables
dotenv.config();

// Helper functions
async function ensureDirectoryExists(dir: string): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

interface TemplateConfig {
  name: string;
  description: string;
  sequence: (number | string)[];
  durations: number[] | Record<string | number, number>;
  music?: {
    path: string;
    volume?: number;
    startTime?: number;
  };
  transitions?: {
    type: "crossfade" | "fade" | "slide";
    duration: number;
  }[];
}

function adaptSequenceForImages(
  sequence: (number | string)[],
  availableImages: number
): (number | string)[] {
  if (availableImages >= sequence.filter((s) => s !== "map").length)
    return sequence;

  // If we have fewer images than slots, adapt the sequence
  return sequence.map((item) => {
    if (item === "map") return item;
    const index = typeof item === "number" ? item : parseInt(item);
    return index % availableImages;
  });
}

async function stitchVideos({
  videos,
  sequence,
  outputPath,
  mapVideo,
}: {
  videos: string[];
  sequence: (number | string)[];
  outputPath: string;
  mapVideo?: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
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
      .on("end", () => {
        console.log("Video stitching complete");
        resolve();
      })
      .on("error", (err: Error) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .run();
  });
}

async function testTemplateProcessing() {
  console.log("\nTemplate Processing Stage:");
  console.log("-------------------------");

  // Check required environment variables
  if (!process.env.AWS_BUCKET) {
    throw new Error("AWS_BUCKET environment variable is not set");
  }

  // Create temp directories
  await ensureDirectoryExists("./temp");
  await ensureDirectoryExists("./temp/final");

  // Use the existing generated videos from the previous run
  const runwayOutputPaths = [
    "temp/a59211cc-7563-482d-bc73-125280899f57/segment_0.mp4",
    "temp/346e7af8-e4be-4d8b-85d4-2f215a196ea6/segment_1.mp4",
    "temp/f14db254-cb08-434f-b5b0-99efc816458c/segment_2.mp4",
  ];

  // Verify that the input videos exist
  for (const videoPath of runwayOutputPaths) {
    try {
      await fs.access(videoPath);
    } catch {
      console.error(`Input video not found: ${videoPath}`);
      throw new Error(
        "Input videos are missing. Please run the Runway stage first."
      );
    }
  }

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
      if (!process.env.GOOGLE_MAPS_API_KEY) {
        throw new Error("GOOGLE_MAPS_API_KEY environment variable is not set");
      }

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
      const s3Url = await s3VideoService.uploadVideo(
        outputPath,
        `s3://${process.env.AWS_BUCKET}/${s3Key}`
      );

      console.log(`Successfully processed ${template} template`);
      console.log(`Uploaded to: ${s3Url}`);
    } catch (error) {
      console.error(`Failed to process ${template} template:`, error);
    }
  }

  console.log("\nTemplate Processing Stage: Complete");
}

// Run the test
testTemplateProcessing().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
