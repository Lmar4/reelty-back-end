import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { imageToVideoConverter } from "./services/imageProcessing/imageToVideoConverter";
import * as path from "path";
import * as fs from "fs";
import { ProductionPipeline } from "./services/imageProcessing/productionPipeline";

const prisma = new PrismaClient();
const pipeline = new ProductionPipeline();

async function runProductionTest() {
  try {
    const timestamp = Date.now();
    // 1. Create a test listing
    const listing = await prisma.listing.create({
      data: {
        address: "123 Test Street, Test City, TS 12345",
        status: "ACTIVE",
        coordinates: {
          lat: 37.7749,
          lng: -122.4194,
        },
        user: {
          create: {
            id: `test-${timestamp}`,
            email: `test-${timestamp}@example.com`,
            password: "test-password",
            role: "USER",
          },
        },
      },
    });

    console.log("Created test listing:", listing);

    // 2. Create photos for the listing
    const testImagesDir = path.join(
      __dirname,
      "../public/assets/testing_image"
    );
    const imageFiles = await fs.promises.readdir(testImagesDir);
    const imagePaths = imageFiles
      .filter((file) => file.endsWith(".jpg"))
      .map((file) => path.join(testImagesDir, file));

    const photos = await Promise.all(
      imagePaths.map(async (filePath, index) => {
        return prisma.photo.create({
          data: {
            listingId: listing.id,
            userId: listing.userId,
            filePath: filePath,
            order: index,
            status: "PENDING",
          },
        });
      })
    );

    console.log(`Created ${photos.length} test photos`);

    // 3. Create a video job
    const job = await prisma.videoJob.create({
      data: {
        userId: listing.userId,
        listingId: listing.id,
        status: VideoGenerationStatus.QUEUED,
        template: "storyteller",
        inputFiles: imagePaths,
      },
    });

    console.log("Created video job:", job);

    // 4. Process the job using the converter's method
    console.log("Starting video generation...");
    const outputVideo = await imageToVideoConverter.convertImagesToVideo(
      imagePaths,
      {
        duration: 10,
        ratio: "768:1280",
        watermark: true,
      }
    );

    // Update job with the output video
    await prisma.videoJob.update({
      where: { id: job.id },
      data: {
        status: VideoGenerationStatus.COMPLETED,
        outputFile: outputVideo,
        completedAt: new Date(),
      },
    });

    console.log("Test completed successfully!");
    console.log("Output video:", outputVideo);
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

async function testTemplateProcessing() {
  try {
    console.log("[TEST] Starting template processing test");

    // Create a test listing
    const listing = await prisma.listing.create({
      data: {
        address: "123 Test St",
        description: "Test Description",
        status: "ACTIVE",
        userId: "test-user", // Make sure this user exists
        photoLimit: 10,
        coordinates: { lat: 37.7749, lng: -122.4194 },
      },
    });

    // Create a test job
    const job = await prisma.videoJob.create({
      data: {
        userId: "test-user",
        listingId: listing.id,
        status: VideoGenerationStatus.QUEUED,
        template: "storyteller",
        inputFiles: [
          path.join(
            __dirname,
            "../public/assets/testing_image/20231124_152245.jpg"
          ),
          path.join(
            __dirname,
            "../public/assets/testing_image/20231124_152550.jpg"
          ),
          path.join(
            __dirname,
            "../public/assets/testing_image/20231124_154240.jpg"
          ),
        ] as string[],
      },
    });

    console.log("[TEST] Created test job:", job.id);

    // Execute the pipeline
    const result = await pipeline.execute({
      jobId: job.id,
      inputFiles: job.inputFiles as string[],
      template: "storyteller",
      coordinates: {
        lat: 37.7749,
        lng: -122.4194,
      },
    });

    console.log("[TEST] Pipeline execution completed:", {
      result,
      jobId: job.id,
    });

    // Verify the job status
    const updatedJob = await prisma.videoJob.findUnique({
      where: { id: job.id },
    });

    console.log("[TEST] Final job status:", {
      status: updatedJob?.status,
      outputFile: updatedJob?.outputFile,
      error: updatedJob?.error,
      metadata: updatedJob?.metadata,
    });
  } catch (error) {
    console.error("[TEST] Test failed:", error);
    throw error;
  }
}

async function testProductionPipeline() {
  try {
    console.log("[TEST] Starting production pipeline test");

    // Get all test images
    const testImagesDir = path.join(
      __dirname,
      "../public/assets/testing_image"
    );
    const imageFiles = fs
      .readdirSync(testImagesDir)
      .filter((file) => file.endsWith(".jpg"))
      .map((file) => path.join(testImagesDir, file));

    if (imageFiles.length !== 10) {
      console.warn(
        "[TEST] Warning: Expected 10 test images, found:",
        imageFiles.length
      );
    }

    console.log("[TEST] Found test images:", {
      count: imageFiles.length,
      files: imageFiles.map((f) => path.basename(f)),
    });

    // Create a test listing with coordinates for map generation
    const listing = await prisma.listing.create({
      data: {
        address: "123 Test Street, San Francisco, CA 94105",
        userId: "test-user",
        status: "ACTIVE",
        coordinates: {
          lat: 37.7749,
          lng: -122.4194,
        },
      },
    });

    console.log("[TEST] Created test listing:", {
      id: listing.id,
      address: listing.address,
      coordinates: listing.coordinates,
    });

    // Create a video job with all templates
    const job = await prisma.videoJob.create({
      data: {
        userId: "test-user",
        listingId: listing.id,
        status: VideoGenerationStatus.PROCESSING,
        template: "storyteller",
        inputFiles: imageFiles,
        metadata: {
          stage: "init",
          startTime: new Date().toISOString(),
        },
      },
    });

    console.log("[TEST] Created video job:", {
      id: job.id,
      template: job.template,
      imageCount: imageFiles.length,
    });

    // Initialize production pipeline
    const pipeline = new ProductionPipeline();

    // Execute the pipeline with all templates
    console.log("[TEST] Executing pipeline with job:", {
      jobId: job.id,
      imageCount: imageFiles.length,
      template: job.template,
    });

    const result = await pipeline.execute({
      jobId: job.id,
      inputFiles: imageFiles,
      template: "storyteller",
      coordinates: {
        lat: 37.7749,
        lng: -122.4194,
      },
      isRegeneration: false,
    });

    console.log("[TEST] Pipeline execution completed:", {
      jobId: job.id,
      result,
      duration: `${
        (Date.now() - new Date(job.startedAt || Date.now()).getTime()) / 1000
      }s`,
    });

    // Get final job status
    const finalJob = await prisma.videoJob.findUnique({
      where: { id: job.id },
      include: {
        listing: true,
      },
    });

    console.log("[TEST] Final job status:", {
      id: finalJob?.id,
      status: finalJob?.status,
      progress: finalJob?.progress,
      error: finalJob?.error,
      outputFile: finalJob?.outputFile,
      metadata: finalJob?.metadata,
    });

    // Clean up
    await prisma.videoJob.delete({ where: { id: job.id } });
    await prisma.listing.delete({ where: { id: listing.id } });

    console.log("[TEST] Test completed successfully");
    return result;
  } catch (error) {
    console.error("[TEST] Test failed:", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

// Run the test
runProductionTest().catch(console.error);
testTemplateProcessing()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });

testProductionPipeline()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });
