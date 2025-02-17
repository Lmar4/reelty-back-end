import { PrismaClient } from "@prisma/client";
import * as path from "path";
import { config } from "dotenv";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";
import { logger } from "../utils/logger";
import { TemplateKey } from "../services/imageProcessing/templates/types";

const ALL_TEMPLATES: TemplateKey[] = [
  "crescendo",
  "wave",
  "storyteller",
  "googlezoomintro",
  "wesanderson",
  "hyperpop",
];
// Load environment variables from .env file
config();

const prisma = new PrismaClient();

async function testTemplateGeneration() {
  try {
    // Create a test job
    const jobId = await createTestJob();
    logger.info("Created test job", { jobId });

    // Get sample video paths
    const sampleVideos = Array.from({ length: 10 }, (_, i) =>
      path.join(process.cwd(), "temp", "samples", `segment_${i}.mp4`)
    );

    // Create pipeline instance
    const pipeline = new ProductionPipeline();

    // Process videos with all templates
    for (const template of ALL_TEMPLATES) {
      logger.info(`Processing template: ${template}`);

      const result = await pipeline.execute({
        jobId,
        inputFiles: sampleVideos,
        template,
        coordinates: {
          lat: 37.7749,
          lng: -122.4194,
        },
        _skipRunway: true, // Skip Runway processing since we already have videos
      });

      logger.info(`Template ${template} processing completed`, { result });
    }

    // Get and log the job results
    const job = await prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        progress: true,
        outputFile: true,
        metadata: true,
      },
    });

    logger.info("Final job status", {
      status: job?.status,
      progress: job?.progress,
      outputFile: job?.outputFile,
      templates: job?.metadata ? (job.metadata as any).templates : undefined,
    });
  } catch (error) {
    logger.error("Test failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function createTestJob() {
  const testListingId = "test_listing";

  // Create a test user if not exists
  const user = await prisma.user.upsert({
    where: { email: "test@reelty.com" },
    update: {},
    create: {
      id: "test_user",
      email: "test@reelty.com",
      password: "test",
      currentTier: {
        create: {
          name: "Test Tier",
          description: "Test tier with all features",
          stripePriceId: "test_price",
          stripeProductId: "test_product",
          features: ["all"],
          monthlyPrice: 0,
          premiumTemplatesEnabled: true,
        },
      },
    },
    include: {
      currentTier: true,
    },
  });

  // Create a test listing if not exists
  const listing = await prisma.listing.upsert({
    where: { id: testListingId },
    update: {},
    create: {
      id: testListingId,
      userId: user.id,
      address: "123 Test St, San Francisco, CA 94105",
      status: "ACTIVE",
      coordinates: JSON.stringify({
        lat: 37.7749,
        lng: -122.4194,
      }),
    },
  });

  // Create a video job
  const job = await prisma.videoJob.create({
    data: {
      userId: user.id,
      listingId: listing.id,
      status: "QUEUED",
      template: "storyteller",
      priority: 1,
    },
  });

  return job.id;
}

// Run the test
testTemplateGeneration().catch(console.error);
