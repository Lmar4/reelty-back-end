import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { PrismaClient, VideoGenerationStatus, Prisma } from "@prisma/client";
import "@testing-library/jest-dom";
import fs from "fs/promises";
import path from "path";
import { mapCaptureService } from "../../map-capture/map-capture.service";
import { runwayService } from "../../video/runway.service";
import { videoTemplateService } from "../../video/video-template.service";
import { ProductionPipeline } from "../productionPipeline";
import type { TemplateKey } from "../templates/types";
import { TEST_CONFIG } from "./testConfig";

// Extend ProductionPipeline to expose protected methods for testing
class TestProductionPipeline extends ProductionPipeline {
  public async testProcessTemplates(
    ...args: Parameters<ProductionPipeline["processTemplates"]>
  ) {
    return this.processTemplates(...args);
  }

  public async testCleanup() {
    return this.cleanup();
  }
}

// Mock external services
jest.mock("../../video/runway.service", () => ({
  runwayService: {
    generateVideo: jest.fn(),
  },
}));

jest.mock("../../video/video-template.service", () => ({
  videoTemplateService: {
    createTemplate: jest.fn(),
  },
}));

jest.mock("../../map-capture/map-capture.service", () => ({
  mapCaptureService: {
    generateMapVideo: jest.fn(),
  },
}));

describe("ProductionPipeline Template Processing", () => {
  let pipeline: TestProductionPipeline;
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Setup test database and dependencies
    prisma = new PrismaClient();
    pipeline = new TestProductionPipeline();

    // Create test temp directory
    await fs.mkdir(TEST_CONFIG.TEMP_DIR, { recursive: true });

    // Cleanup any existing test data first (in correct order)
    await prisma.$transaction(async (tx) => {
      // Delete all related records first
      await tx.videoJob.deleteMany({
        where: {
          OR: [
            { id: TEST_CONFIG.TEST_JOB_ID },
            { userId: TEST_CONFIG.TEST_USER_ID },
          ],
        },
      });

      await tx.listing.deleteMany({
        where: {
          OR: [
            { id: TEST_CONFIG.TEST_LISTING_ID },
            { userId: TEST_CONFIG.TEST_USER_ID },
          ],
        },
      });

      await tx.user.deleteMany({
        where: {
          OR: [{ id: TEST_CONFIG.TEST_USER_ID }, { email: "test@example.com" }],
        },
      });

      // Create test user
      const user = await tx.user.create({
        data: {
          id: TEST_CONFIG.TEST_USER_ID,
          email: "test@example.com",
          password: "test_password",
          role: "USER",
          subscriptionStatus: "INACTIVE",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Create test listing
      const listing = await tx.listing.create({
        data: {
          id: TEST_CONFIG.TEST_LISTING_ID,
          userId: user.id,
          status: "DRAFT",
          address: "123 Test St",
          photoLimit: 10,
          coordinates: JSON.stringify(TEST_CONFIG.COORDINATES.NEW_YORK),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Create test job
      await tx.videoJob.create({
        data: {
          id: TEST_CONFIG.TEST_JOB_ID,
          status: VideoGenerationStatus.PROCESSING,
          metadata: {},
          user: { connect: { id: user.id } },
          listing: { connect: { id: listing.id } },
        },
      });
    });

    // Setup mock responses
    jest
      .mocked(runwayService.generateVideo)
      .mockImplementation(async (file: string) =>
        path.join(TEST_CONFIG.TEMP_DIR, `runway_${Date.now()}.mp4`)
      );

    jest
      .mocked(videoTemplateService.createTemplate)
      .mockImplementation(async (template: string, videos: string[]) => [
        {
          path: path.join(
            TEST_CONFIG.TEMP_DIR,
            `${template}_${Date.now()}.mp4`
          ),
          duration: 30,
        },
      ]);

    jest
      .mocked(mapCaptureService.generateMapVideo)
      .mockImplementation(async (coordinates: any) =>
        path.join(TEST_CONFIG.TEMP_DIR, `map_${Date.now()}.mp4`)
      );
  });

  afterAll(async () => {
    // Cleanup in reverse order of dependencies
    await prisma.$transaction(async (tx) => {
      // Delete all related records
      await tx.videoJob.deleteMany({
        where: {
          OR: [
            { id: TEST_CONFIG.TEST_JOB_ID },
            { userId: TEST_CONFIG.TEST_USER_ID },
          ],
        },
      });

      await tx.listing.deleteMany({
        where: {
          OR: [
            { id: TEST_CONFIG.TEST_LISTING_ID },
            { userId: TEST_CONFIG.TEST_USER_ID },
          ],
        },
      });

      await tx.user.deleteMany({
        where: {
          OR: [{ id: TEST_CONFIG.TEST_USER_ID }, { email: "test@example.com" }],
        },
      });
    });

    await fs.rm(TEST_CONFIG.TEMP_DIR, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Template Processing", () => {
    it("should process multiple templates in parallel batches", async () => {
      const results = await pipeline.testProcessTemplates(
        TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
        TEST_CONFIG.TEST_JOB_ID,
        TEST_CONFIG.TEMPLATES.BASIC
      );

      expect(results).toHaveLength(TEST_CONFIG.TEMPLATES.BASIC.length);

      // Verify job metadata contains template results
      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
      });

      expect(job?.metadata).toHaveProperty("templateResults");
      const metadata = job?.metadata as any;
      expect(metadata.templateResults).toHaveLength(
        TEST_CONFIG.TEMPLATES.BASIC.length
      );
      expect(
        metadata.templateResults.every((r: any) => r.status === "SUCCESS")
      ).toBe(true);
    });

    it("should continue processing if one template fails", async () => {
      // Clear all mocks and caches first
      jest.clearAllMocks();
      await prisma.processedAsset.deleteMany();

      // Mock one template to fail
      jest
        .mocked(videoTemplateService.createTemplate)
        .mockImplementation(async (template: TemplateKey, videos: string[]) => {
          if (template === ("storyteller" as TemplateKey)) {
            throw new Error("Template processing failed");
          }
          return [
            {
              path: path.join(
                TEST_CONFIG.TEMP_DIR,
                `${template}_${Date.now()}.mp4`
              ),
              duration: 30,
            },
          ];
        });

      const results = await pipeline.testProcessTemplates(
        TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
        TEST_CONFIG.TEST_JOB_ID,
        TEST_CONFIG.TEMPLATES.BASIC
      );

      // Should still get results for the other templates
      expect(results.length).toBe(2);

      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
      });

      const metadata = job?.metadata as any;
      expect(metadata.templateResults).toHaveLength(3);
      const failedResult = metadata.templateResults.find(
        (r: any) => r.status === "FAILED"
      );
      expect(failedResult).toBeTruthy();
      expect(failedResult.template).toBe("storyteller");
    });

    it("should generate map video for googlezoomintro template", async () => {
      // Clear all mocks and caches first
      jest.clearAllMocks();
      await prisma.processedAsset.deleteMany();

      // Mock map video generation
      jest
        .mocked(mapCaptureService.generateMapVideo)
        .mockResolvedValue(
          path.join(TEST_CONFIG.TEMP_DIR, `map_${Date.now()}.mp4`)
        );

      // Mock template creation
      jest.mocked(videoTemplateService.createTemplate).mockResolvedValue([
        {
          path: path.join(
            TEST_CONFIG.TEMP_DIR,
            `googlezoomintro_${Date.now()}.mp4`
          ),
          duration: 30,
        },
      ]);

      const results = await pipeline.testProcessTemplates(
        TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
        TEST_CONFIG.TEST_JOB_ID,
        TEST_CONFIG.TEMPLATES.MAP_REQUIRED,
        TEST_CONFIG.COORDINATES.NEW_YORK
      );

      expect(results).toHaveLength(1);
      expect(mapCaptureService.generateMapVideo).toHaveBeenCalledWith(
        TEST_CONFIG.COORDINATES.NEW_YORK,
        TEST_CONFIG.TEST_JOB_ID
      );

      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
      });

      const metadata = job?.metadata as any;
      expect(metadata.templateResults[0].status).toBe("SUCCESS");
      expect(metadata.templateResults[0].template).toBe("googlezoomintro");
    });

    it("should handle template validation errors", async () => {
      // Clear all mocks and caches first
      jest.clearAllMocks();
      await prisma.processedAsset.deleteMany();

      // Test with missing coordinates for map template first
      const error = await pipeline
        .testProcessTemplates(
          TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
          TEST_CONFIG.TEST_JOB_ID,
          TEST_CONFIG.TEMPLATES.MAP_REQUIRED
        )
        .catch((e) => e);

      expect(error.message).toBe(
        "Template googlezoomintro requires coordinates"
      );

      // Then test with all templates failing
      jest
        .mocked(videoTemplateService.createTemplate)
        .mockRejectedValue(new Error("All templates failed"));

      const error2 = await pipeline
        .testProcessTemplates(
          TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
          TEST_CONFIG.TEST_JOB_ID,
          TEST_CONFIG.TEMPLATES.BASIC
        )
        .catch((e) => e);

      expect(error2.message).toBe("No templates were successfully generated");
    });
  });

  describe("Resource Management", () => {
    it("should track and cleanup resources after processing", async () => {
      // Clear all mocks and caches first
      jest.clearAllMocks();
      await prisma.processedAsset.deleteMany();

      // Mock successful template creation
      jest.mocked(videoTemplateService.createTemplate).mockResolvedValue([
        {
          path: path.join(TEST_CONFIG.TEMP_DIR, `template_${Date.now()}.mp4`),
          duration: 30,
        },
      ]);

      const results = await pipeline.testProcessTemplates(
        TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
        TEST_CONFIG.TEST_JOB_ID,
        TEST_CONFIG.TEMPLATES.BASIC
      );

      // Verify resources were tracked
      expect(
        results.every((path) => path.startsWith(TEST_CONFIG.TEMP_DIR))
      ).toBe(true);

      // Call cleanup
      await pipeline.testCleanup();

      // Verify temp files are removed
      for (const result of results) {
        await expect(fs.access(result)).rejects.toThrow();
      }
    });

    it("should handle cleanup errors gracefully", async () => {
      // Clear all mocks and caches first
      jest.clearAllMocks();
      await prisma.processedAsset.deleteMany();

      // Mock successful template creation
      jest.mocked(videoTemplateService.createTemplate).mockResolvedValue([
        {
          path: path.join(TEST_CONFIG.TEMP_DIR, `template_${Date.now()}.mp4`),
          duration: 30,
        },
      ]);

      await pipeline.testProcessTemplates(
        TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY,
        TEST_CONFIG.TEST_JOB_ID,
        TEST_CONFIG.TEMPLATES.BASIC
      );

      // Mock fs.unlink to fail
      const originalUnlink = fs.unlink;
      const mockUnlink = jest
        .fn<typeof fs.unlink>()
        .mockRejectedValue(new Error("Cleanup failed"));
      (fs.unlink as unknown) = mockUnlink;

      // Cleanup should not throw
      await expect(pipeline.testCleanup()).resolves.not.toThrow();

      // Restore original unlink
      (fs.unlink as unknown) = originalUnlink;
    });
  });

  describe("Single Photo Processing", () => {
    const SINGLE_PHOTO_ID = "b8fcb635-5442-4ac8-ae8d-b5e5444e3ddd";
    const SINGLE_PHOTO_PATH = path.join(TEST_CONFIG.TEMP_DIR, "test_photo.jpg");

    beforeEach(async () => {
      // Clear previous test data
      await prisma.$transaction(async (tx) => {
        await tx.photo.deleteMany({
          where: { id: SINGLE_PHOTO_ID },
        });
        await tx.processedAsset.deleteMany({
          where: { type: "runway" },
        });
      });

      // Create a test photo
      await prisma.photo.create({
        data: {
          id: SINGLE_PHOTO_ID,
          userId: TEST_CONFIG.TEST_USER_ID,
          listingId: TEST_CONFIG.TEST_LISTING_ID,
          status: "COMPLETED",
          processedFilePath: SINGLE_PHOTO_PATH,
          filePath: SINGLE_PHOTO_PATH,
          s3Key: `test/${SINGLE_PHOTO_ID}.jpg`,
          order: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Reset mocks
      jest.clearAllMocks();
    });

    it("should process a single photo regeneration", async () => {
      // Mock runway video generation
      const mockRunwayVideo = path.join(
        TEST_CONFIG.TEMP_DIR,
        `runway_${Date.now()}.mp4`
      );
      jest
        .mocked(runwayService.generateVideo)
        .mockResolvedValue(mockRunwayVideo);

      // Mock template generation
      const mockTemplateVideo = path.join(
        TEST_CONFIG.TEMP_DIR,
        `template_${Date.now()}.mp4`
      );
      jest.mocked(videoTemplateService.createTemplate).mockResolvedValue([
        {
          path: mockTemplateVideo,
          duration: 30,
        },
      ]);

      // Execute regeneration
      await pipeline.regeneratePhotos(TEST_CONFIG.TEST_JOB_ID, [
        SINGLE_PHOTO_ID,
      ]);

      // Verify the photo status was updated correctly
      const updatedPhoto = await prisma.photo.findUnique({
        where: { id: SINGLE_PHOTO_ID },
      });
      expect(updatedPhoto?.status).toBe("COMPLETED");
      expect(updatedPhoto?.error).toBeNull();

      // Verify the job was updated with the regeneration results
      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
        select: { status: true, metadata: true, outputFile: true },
      });

      expect(job?.status).toBe(VideoGenerationStatus.COMPLETED);
      expect(job?.outputFile).toBeTruthy();

      const metadata = job?.metadata as any;
      expect(metadata.regeneration).toBeDefined();
      expect(metadata.regeneration.regeneratedPhotoIds).toContain(
        SINGLE_PHOTO_ID
      );
      expect(metadata.regeneration.totalPhotos).toBe(1);
    });

    it("should handle errors during single photo regeneration", async () => {
      // Mock runway service to fail
      jest
        .mocked(runwayService.generateVideo)
        .mockRejectedValue(new Error("Runway processing failed"));

      // Execute regeneration and expect it to fail
      await expect(
        pipeline.regeneratePhotos(TEST_CONFIG.TEST_JOB_ID, [SINGLE_PHOTO_ID])
      ).rejects.toThrow("Runway processing failed");

      // Verify the photo status was updated to failed
      const updatedPhoto = await prisma.photo.findUnique({
        where: { id: SINGLE_PHOTO_ID },
      });
      expect(updatedPhoto?.status).toBe("FAILED");
      expect(updatedPhoto?.error).toBe("Runway processing failed");

      // Verify the job status
      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
      });
      expect(job?.status).toBe(VideoGenerationStatus.FAILED);
    });

    it("should reuse existing runway videos when available", async () => {
      // Create a mock processed asset for the photo
      const existingVideoPath = path.join(
        TEST_CONFIG.TEMP_DIR,
        "existing_runway.mp4"
      );
      const cacheKey = require("crypto")
        .createHash("md5")
        .update(
          JSON.stringify({
            type: "runway",
            inputFiles: [SINGLE_PHOTO_PATH],
          })
        )
        .digest("hex");

      await prisma.processedAsset.create({
        data: {
          type: "runway",
          path: existingVideoPath,
          cacheKey: `runway_${cacheKey}`,
          hash: cacheKey,
          metadata: {
            sourceFile: SINGLE_PHOTO_PATH,
            timestamp: Date.now(),
          },
        },
      });

      // Mock template generation
      const mockTemplateVideo = path.join(
        TEST_CONFIG.TEMP_DIR,
        `template_${Date.now()}.mp4`
      );
      jest.mocked(videoTemplateService.createTemplate).mockResolvedValue([
        {
          path: mockTemplateVideo,
          duration: 30,
        },
      ]);

      // Execute regeneration
      await pipeline.regeneratePhotos(TEST_CONFIG.TEST_JOB_ID, [
        SINGLE_PHOTO_ID,
      ]);

      // Verify runway service was not called
      expect(runwayService.generateVideo).not.toHaveBeenCalled();

      // Verify the job completed successfully
      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
      });
      expect(job?.status).toBe(VideoGenerationStatus.COMPLETED);
    });

    it("should maintain correct progress tracking during single photo processing", async () => {
      const progressUpdates: Array<{
        progress: number;
        stage?: string;
        status: VideoGenerationStatus;
      }> = [];

      // Mock prisma update to capture progress updates
      const originalUpdate = prisma.videoJob.update;
      prisma.videoJob.update = jest.fn(
        async (params: Prisma.VideoJobUpdateArgs) => {
          if (params.data.progress !== undefined) {
            progressUpdates.push({
              progress: params.data.progress as number,
              stage: (params.data.metadata as any)?.currentStage,
              status: params.data.status as VideoGenerationStatus,
            });
          }
          return originalUpdate(params);
        }
      ) as any;

      // Mock successful processing
      const mockRunwayVideo = path.join(
        TEST_CONFIG.TEMP_DIR,
        `runway_${Date.now()}.mp4`
      );
      jest
        .mocked(runwayService.generateVideo)
        .mockResolvedValue(mockRunwayVideo);

      const mockTemplateVideo = path.join(
        TEST_CONFIG.TEMP_DIR,
        `template_${Date.now()}.mp4`
      );
      jest.mocked(videoTemplateService.createTemplate).mockResolvedValue([
        {
          path: mockTemplateVideo,
          duration: 30,
        },
      ]);

      // Execute regeneration
      await pipeline.regeneratePhotos(TEST_CONFIG.TEST_JOB_ID, [
        SINGLE_PHOTO_ID,
      ]);

      // Verify progress tracking
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0].progress).toBe(0); // Initial progress
      expect(progressUpdates[progressUpdates.length - 1].progress).toBe(100); // Final progress

      // Verify stage transitions
      const stages = progressUpdates.map((update) => update.stage);
      expect(stages).toContain("runway");
      expect(stages).toContain("template");
      expect(stages).toContain("upload");

      // Restore original prisma update
      prisma.videoJob.update = originalUpdate;
    });

    it("should create all required templates during single photo regeneration", async () => {
      // Mock runway video generation
      const mockRunwayVideo = path.join(
        TEST_CONFIG.TEMP_DIR,
        `runway_${Date.now()}.mp4`
      );
      jest
        .mocked(runwayService.generateVideo)
        .mockResolvedValue(mockRunwayVideo);

      // Track template creation calls
      const createdTemplates: Record<string, string> = {};
      jest
        .mocked(videoTemplateService.createTemplate)
        .mockImplementation(async (template: TemplateKey, videos: string[]) => {
          const templatePath = path.join(
            TEST_CONFIG.TEMP_DIR,
            `${template}_${Date.now()}.mp4`
          );
          createdTemplates[template] = templatePath;
          return [
            {
              path: templatePath,
              duration: 30,
            },
          ];
        });

      // Execute regeneration
      await pipeline.regeneratePhotos(TEST_CONFIG.TEST_JOB_ID, [
        SINGLE_PHOTO_ID,
      ]);

      // Verify all templates were created
      const expectedTemplates = [
        "crescendo",
        "wave",
        "storyteller",
        "googlezoomintro",
        "wesanderson",
        "hyperpop",
      ];

      // Check each template was created
      for (const template of expectedTemplates) {
        expect(createdTemplates[template]).toBeDefined();
        expect(createdTemplates[template]).toContain(template);
      }

      // Verify the job metadata contains all template results
      const job = await prisma.videoJob.findUnique({
        where: { id: TEST_CONFIG.TEST_JOB_ID },
        select: {
          metadata: true,
          outputFile: true,
        },
      });

      const metadata = job?.metadata as any;
      expect(metadata.templates).toBeDefined();
      expect(metadata.templates).toHaveLength(expectedTemplates.length);

      // Verify each template has a valid path and no errors
      for (const templateResult of metadata.templates) {
        expect(templateResult.key).toBeDefined();
        expect(templateResult.path).toBeTruthy();
        expect(templateResult.error).toBeNull();
      }

      // Verify the primary template (storyteller) was set as the output
      const primaryTemplate = metadata.templates.find(
        (t: any) => t.key === "storyteller"
      );
      expect(primaryTemplate).toBeDefined();
      expect(job?.outputFile).toBe(primaryTemplate.path);
    });
  });
});
