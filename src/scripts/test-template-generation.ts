import path from "path";
import { videoProcessingService } from "../services/video/video-processing.service";
import {
  reelTemplates,
  TemplateKey,
} from "../services/imageProcessing/templates/types";
import { logger } from "../utils/logger";
import pLimit from "p-limit";
import fs from "fs/promises";
import { existsSync } from "fs";
import { EventEmitter } from "events";
const TEST_JOB_ID = "67791855-7180-41f5-a7ab-8fb8e0831fbc";
const TEST_LISTING_ID = "test-listing";
const BATCH_SIZE = 2;

interface TemplateProcessingResult {
  template: TemplateKey;
  status: "SUCCESS" | "FAILED";
  outputPath: string | null;
  error?: string;
  processingTime?: number;
}

async function processTemplate(
  template: TemplateKey,
  segmentPaths: string[],
  mapVideoPath: string,
  watermarkPath: string,
  outputDir: string
): Promise<TemplateProcessingResult> {
  const startTime = Date.now();
  const templateConfig = reelTemplates[template];
  const durations = Array.isArray(templateConfig.durations)
    ? templateConfig.durations
    : Object.values(templateConfig.durations);

  // Limit to available segments (10) and ensure durations match
  const combinedVideos: string[] = [];
  const adjustedDurations: number[] = [];
  let segmentCount = 0;

  for (const item of templateConfig.sequence) {
    if (segmentCount >= segmentPaths.length) break; // Stop at 10 segments
    if (item === "map") {
      combinedVideos.push(mapVideoPath);
      adjustedDurations.push(
        typeof templateConfig.durations === "object"
          ? (templateConfig.durations as Record<string, number>).map
          : durations[segmentCount]
      );
    } else {
      const videoIndex = typeof item === "string" ? parseInt(item) : item;
      if (videoIndex < segmentPaths.length) {
        combinedVideos.push(segmentPaths[videoIndex]);
        adjustedDurations.push(durations[segmentCount]);
        segmentCount++;
      }
    }
  }

  // Log configuration
  logger.info(`Template ${template} clip configuration:`, {
    clipCount: combinedVideos.length,
    totalDuration: adjustedDurations.reduce((sum, d) => sum + (d || 0), 0),
    durations: adjustedDurations,
    sequence: templateConfig.sequence.slice(0, segmentCount),
  });

  const clips = combinedVideos.map((path, index) => {
    const duration = adjustedDurations[index];
    if (duration === undefined) {
      throw new Error(`No duration defined for clip ${index}: ${path}`);
    }
    return {
      path,
      duration,
      transition: templateConfig.transitions?.[index > 0 ? index - 1 : 0],
      colorCorrection: templateConfig.colorCorrection,
    };
  });

  const outputPath = path.join(outputDir, `${template}_output.mp4`);
  await videoProcessingService.stitchVideos(
    clips,
    outputPath,
    {
      name: templateConfig.name,
      description: templateConfig.description,
      colorCorrection: templateConfig.colorCorrection,
      transitions: templateConfig.transitions,
      reverseClips: templateConfig.reverseClips,
      music: {
        path: path.join(process.cwd(), "temp", TEST_JOB_ID, `${template}.mp3`),
      },
      outputOptions: ["-q:a 2"],
    },
    {
      path: watermarkPath,
      position: { x: "(main_w-overlay_w)/2", y: "main_h-overlay_h-180" },
    }
  );

  return {
    template,
    status: "SUCCESS",
    outputPath,
    processingTime: Date.now() - startTime,
  };
}

async function main() {
  const startTime = Date.now();
  const baseDir = path.join(process.cwd(), "temp", TEST_JOB_ID);
  const outputDir = path.join(baseDir, "output");
  const limit = pLimit(BATCH_SIZE);

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Get all segment paths in order
  const segmentPaths: string[] = [];
  for (let i = 0; i < 10; i++) {
    const segmentPath = path.join(baseDir, `segment_${i}.mp4`);
    if (existsSync(segmentPath)) {
      segmentPaths.push(segmentPath);
    }
  }

  const mapVideoPath = path.join(
    baseDir,
    "map-95b2ccdc53a09ad84e3e4019853dfbd6.mp4"
  );
  const watermarkPath = path.join(baseDir, "reeltywatermark.png");

  // Process all templates in batches
  const templates: TemplateKey[] = [
    "crescendo",
    "wave",
    "storyteller",
    "googlezoomintro",
    "wesanderson",
    "hyperpop",
  ];

  logger.info("Starting template processing test", {
    segmentCount: segmentPaths.length,
    templates: templates.length,
    batchSize: BATCH_SIZE,
    startTime: new Date().toISOString(),
  });

  let completed = 0;
  const results = await Promise.all(
    templates.map(async (template) => {
      const result = await limit(() =>
        processTemplate(
          template,
          segmentPaths,
          mapVideoPath,
          watermarkPath,
          outputDir
        )
      );
      completed++;
      logger.info("Overall progress", {
        completed,
        total: templates.length,
        percent: ((completed / templates.length) * 100).toFixed(1) + "%",
        elapsedTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      });
      return result;
    })
  );

  // Log results
  logger.info("Template processing completed", {
    successful: results.filter((r) => r.status === "SUCCESS").length,
    failed: results.filter((r) => r.status === "FAILED").length,
  });

  results.forEach((result) => {
    if (result.status === "SUCCESS") {
      logger.info(`Template ${result.template} succeeded`, {
        outputPath: result.outputPath,
        processingTime: result.processingTime,
      });
    } else {
      logger.error(`Template ${result.template} failed`, {
        error: result.error,
        processingTime: result.processingTime,
      });
    }
  });
}

main().catch((error) => {
  logger.error("Test script failed", {
    error: error instanceof Error ? error.message : "Unknown error",
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
