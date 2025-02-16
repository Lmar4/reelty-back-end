import path from "path";
import { videoTemplateService } from "../src/services/video/video-template.service";
import { videoProcessingService } from "../src/services/video/video-processing.service";
import {
  TemplateKey,
  reelTemplates,
} from "../src/services/imageProcessing/templates/types";
import fs from "fs/promises";
import dotenv from "dotenv";

// Load environment variables from .env file
const envConfig = dotenv.config();

// Set required environment variables
process.env.TEMP_DIR = path.join(__dirname, "../temp");

// Ensure GOOGLE_MAPS_API_KEY is set
if (!process.env.GOOGLE_MAPS_API_KEY && envConfig.parsed?.GOOGLE_MAPS_API_KEY) {
  process.env.GOOGLE_MAPS_API_KEY = envConfig.parsed.GOOGLE_MAPS_API_KEY;
}

if (!process.env.GOOGLE_MAPS_API_KEY) {
  console.error(
    "❌ GOOGLE_MAPS_API_KEY is required for googlezoomintro template"
  );
  process.exit(1);
}

const SAMPLE_VIDEOS_DIR = path.join(__dirname, "../temp/samples");
const OUTPUT_DIR = path.join(__dirname, "../temp/output");

// Define templates to test
const templates = [
  "crescendo",
  "wave",
  "storyteller",
  "googlezoomintro",
  "wesanderson",
  "hyperpop",
] as const;

// Create sample videos array with 10 videos
async function generateSampleVideos(): Promise<string[]> {
  try {
    // Ensure the samples directory exists
    await fs.mkdir(SAMPLE_VIDEOS_DIR, { recursive: true });

    // Create 10 sample video files
    const sampleVideos = Array.from({ length: 10 }, (_, i) => {
      const videoPath = path.join(SAMPLE_VIDEOS_DIR, `segment_${i}.mp4`);
      return videoPath;
    });

    console.log(`Generated ${sampleVideos.length} sample video paths`);
    return sampleVideos;
  } catch (error) {
    console.error("Error generating sample videos:", error);
    throw error;
  }
}

async function testTemplateCreation() {
  try {
    // Create output directory
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Generate sample video paths
    const sampleVideos = await generateSampleVideos();

    console.log("Starting template creation test");
    console.log(`Found ${sampleVideos.length} sample videos`);
    console.log(`Testing templates: ${templates.join(", ")}`);
    console.log(`Output directory: ${OUTPUT_DIR}`);

    // Import mapCaptureService dynamically after environment variables are set
    const { mapCaptureService } = await import(
      "../src/services/map-capture/map-capture.service"
    );

    // Process each template
    for (const template of templates) {
      try {
        console.log(`\nProcessing template: ${template}`);
        const startTime = Date.now();

        // Generate map video for googlezoomintro template
        let mapVideo: string | undefined;
        if (template === "googlezoomintro") {
          const coordinates = { lat: 40.7128, lng: -74.006 }; // NYC coordinates
          console.log("Generating map video for coordinates:", coordinates);
          mapVideo = await mapCaptureService.generateMapVideo(
            coordinates,
            `test_${Date.now()}`
          );
          if (!mapVideo) {
            console.error("❌ Failed to generate map video");
            continue;
          }
          console.log("Map video generated:", { path: mapVideo });
        }

        // Create template with all sample videos
        const clips = await videoTemplateService.createTemplate(
          template,
          sampleVideos,
          mapVideo
        );

        if (!clips || clips.length === 0) {
          console.error(`❌ Template ${template} failed to generate clips`);
          continue;
        }

        // Generate final video
        const outputPath = path.join(OUTPUT_DIR, `${template}_final.mp4`);
        console.log(`Generating final video for ${template}...`);

        await videoProcessingService.processClips(
          clips,
          outputPath,
          reelTemplates[template]
        );

        const duration = Date.now() - startTime;

        // Log success with more detailed information
        console.log(`✅ Successfully created template: ${template}`);
        console.log(`   Number of clips: ${clips.length}`);
        clips.forEach((clip, index) => {
          console.log(`   Clip ${index + 1}: ${clip.path} (${clip.duration}s)`);
        });
        console.log(`   Final video: ${outputPath}`);
        console.log(`   Processing time: ${duration}ms`);
      } catch (error) {
        console.error(`❌ Error processing template ${template}:`, error);
      }
    }

    console.log("\nTemplate creation test completed");
    console.log("Final videos are available in:", OUTPUT_DIR);
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

// Run the test
testTemplateCreation();
