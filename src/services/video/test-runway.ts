/**
 * Test script for video template generation.
 *
 * NOTE: There is a known issue with S3 upload in the Runway service:
 * - The S3 upload in runway.service.ts (downloadResult method) is failing with authorization errors
 * - Current workaround: Using local video segments directly from temp directory
 * - TODO: Fix S3 upload in runway.service.ts to properly handle authorization and pre-signed URLs
 */

import { videoTemplateService } from "./video-template.service";
import { videoProcessingService } from "./video-processing.service";
import { logger } from "../../utils/logger";
import * as path from "path";
import * as fs from "fs/promises";
import { TemplateKey, reelTemplates } from "../imageProcessing/templates/types";

async function testTemplateGeneration() {
  try {
    // Create a dedicated directory for our segments
    const workingDir = path.join(
      process.env.TEMP_OUTPUT_DIR || "./temp",
      "template-test"
    );
    await fs.mkdir(workingDir, { recursive: true });

    // Collect and copy all video segments to working directory
    const segments = [];
    const sourceDir =
      "/var/folders/pq/f2jp607s74jfvz718k1xg21h0000gn/T/reelty-processing";
    const dirs = await fs.readdir(sourceDir);

    logger.info("Copying segments to working directory:", { workingDir });

    for (let i = 0; i < 10; i++) {
      const segmentName = `segment_${i}.mp4`;
      // Find and copy each segment
      for (const dir of dirs) {
        const sourcePath = path.join(sourceDir, dir, segmentName);
        try {
          await fs.access(sourcePath);
          const targetPath = path.join(workingDir, segmentName);
          await fs.copyFile(sourcePath, targetPath);
          segments.push(targetPath);
          logger.info(`Copied segment ${i}:`, {
            from: sourcePath,
            to: targetPath,
          });
          break;
        } catch (error) {
          continue;
        }
      }
    }

    if (segments.length !== 10) {
      throw new Error(`Expected 10 segments, found ${segments.length}`);
    }

    logger.info("All segments copied and ready:", {
      segmentCount: segments.length,
      workingDir,
      segments,
    });

    // Test each template
    const templates: TemplateKey[] = [
      "storyteller",
      "crescendo",
      "wave",
      "googlezoomintro",
    ];
    const results = [];

    // Map video path for googlezoomintro template
    const mapVideoPath =
      "/Users/antonio/DEV/reelty-app/reelty_backend/temp/map-cache/map-2c1e7e1aa869d3283d57c6283ab0d88b.mp4";

    for (const template of templates) {
      try {
        logger.info(`Processing template: ${template}`);

        // Get template configuration
        const templateConfig = reelTemplates[template];
        logger.info(`Template configuration:`, {
          template,
          musicConfig: templateConfig.music,
          hasValidMusic: templateConfig.music?.isValid,
          musicPath: templateConfig.music?.path,
          musicVolume: templateConfig.music?.volume,
        });

        // Create clips configuration for the template
        const clips = await videoTemplateService.createTemplate(
          template,
          segments,
          template === "googlezoomintro" ? mapVideoPath : undefined // Pass map video only for googlezoomintro
        );

        // Create output path for this template
        const outputPath = path.join(
          workingDir,
          `${template}-${Date.now()}.mp4`
        );

        // Generate the video with template configuration
        await videoProcessingService.stitchVideos(
          clips.map((clip) => clip.path),
          clips.map((clip) => clip.duration),
          outputPath,
          reelTemplates[template] // Pass the full template configuration from reelTemplates
        );

        results.push({
          template,
          outputPath,
          success: true,
        });

        logger.info(`Successfully generated video for template ${template}:`, {
          outputPath,
          workingDir,
          hasMapVideo: template === "googlezoomintro",
          hasAudio: !!templateConfig.music,
        });
      } catch (error) {
        logger.error(`Failed to process template ${template}:`, {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        results.push({
          template,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Log final results
    logger.info("Template generation completed:", {
      totalTemplates: templates.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      workingDir,
      results,
    });
  } catch (error) {
    logger.error("Test failed:", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

// Only run if called directly
if (require.main === module) {
  testTemplateGeneration().catch((error) => {
    logger.error("Test script failed:", error);
    process.exit(1);
  });
}
