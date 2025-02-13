/// <reference types="jest" />

import { ImageProcessor } from "../image.service";
import { s3Service } from "../../storage/s3.service";
import { tempFileManager, TempFile } from "../../storage/temp-file.service";
import sharp from "sharp";
import { PrismaClient, Photo, Prisma } from "@prisma/client";

// Mock dependencies
jest.mock("../../storage/s3.service");
jest.mock("../../storage/temp-file.service");

// Mock PrismaClient
jest.mock("@prisma/client", () => {
  const mockFindFirst = jest.fn().mockResolvedValue(null);
  const mockUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

  const mockPhoto = {
    findFirst: mockFindFirst,
    updateMany: mockUpdateMany,
  };

  return {
    PrismaClient: jest.fn(() => ({
      photo: mockPhoto,
    })),
    __mockPhoto: mockPhoto,
  };
});

// Get the mocked photo repository
const mockPhoto = (jest.requireMock("@prisma/client") as any).__mockPhoto;

describe("ImageProcessor", () => {
  let imageProcessor: ImageProcessor;
  let mockBuffer: Buffer;
  let mockPrisma: jest.Mocked<PrismaClient>;

  beforeEach(async () => {
    imageProcessor = new ImageProcessor();
    mockPrisma = new PrismaClient() as jest.Mocked<PrismaClient>;

    // Create a test image buffer
    mockBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .jpeg()
      .toBuffer();

    // Mock S3Service
    (s3Service.parseUrl as jest.Mock).mockReturnValue({
      bucket: "test-bucket",
      key: "test/image.jpg",
      originalUrl: "s3://test-bucket/test/image.jpg",
    });

    (s3Service.downloadFile as jest.Mock).mockResolvedValue(mockBuffer);
    (s3Service.uploadFile as jest.Mock).mockResolvedValue(
      "s3://test-bucket/test/image.webp"
    );

    // Mock TempFileManager
    (tempFileManager.createTempPath as jest.Mock).mockImplementation(
      (filename: string): TempFile => ({
        path: `/tmp/${filename}`,
        filename,
        cleanup: jest.fn(),
      })
    );

    // Reset Prisma mock states
    mockPhoto.findFirst.mockReset().mockResolvedValue(null);
    mockPhoto.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("validateImage", () => {
    it("should validate a correct image buffer", async () => {
      const result = await imageProcessor.validateImage(mockBuffer);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should reject an invalid buffer", async () => {
      const invalidBuffer = Buffer.from("not an image");
      const result = await imageProcessor.validateImage(invalidBuffer);
      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("convertToWebP", () => {
    it("should convert an image to WebP format", async () => {
      const webpBuffer = await imageProcessor.convertToWebP(mockBuffer, {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
      });

      expect(webpBuffer).toBeInstanceOf(Buffer);

      // Verify it's a WebP image
      const metadata = await sharp(webpBuffer).metadata();
      expect(metadata.format).toBe("webp");
    });
  });

  describe("processImage", () => {
    it("should process a new image successfully", async () => {
      const result = await imageProcessor.processImage(
        "s3://test-bucket/test/image.jpg"
      );

      expect(result).toHaveProperty("webpPath");
      expect(result).toHaveProperty("s3WebpPath");
      expect(result).toHaveProperty("uploadPromise");

      expect(s3Service.downloadFile).toHaveBeenCalled();
      expect(s3Service.uploadFile).toHaveBeenCalled();
      expect(tempFileManager.createTempPath).toHaveBeenCalled();
      expect(mockPhoto.updateMany).toHaveBeenCalled();
    });

    it("should handle existing WebP images", async () => {
      const mockPhotoData: Photo = {
        id: "1",
        filePath: "test/image.jpg",
        processedFilePath: "test/image.webp",
        createdAt: new Date(),
        updatedAt: new Date(),
        listingId: "1",
        userId: "test-user-id",
        status: "completed",
        error: null,
        runwayVideoPath: null,
        order: 1,
      };

      mockPhoto.findFirst.mockResolvedValueOnce(mockPhotoData);

      const result = await imageProcessor.processImage(
        "s3://test-bucket/test/image.jpg"
      );

      expect(result.s3WebpPath).toContain("test/image.webp");
      expect(s3Service.downloadFile).toHaveBeenCalledTimes(1);
      expect(s3Service.uploadFile).not.toHaveBeenCalled();
      expect(mockPhoto.updateMany).not.toHaveBeenCalled();
    });

    it("should handle errors and cleanup temp files", async () => {
      (s3Service.downloadFile as jest.Mock).mockRejectedValue(
        new Error("Download failed")
      );

      const mockCleanup = jest.fn();
      (tempFileManager.createTempPath as jest.Mock).mockImplementation(
        (filename: string): TempFile => ({
          path: `/tmp/${filename}`,
          filename,
          cleanup: mockCleanup,
        })
      );

      await expect(
        imageProcessor.processImage("s3://test-bucket/test/image.jpg")
      ).rejects.toThrow("Download failed");

      expect(mockCleanup).toHaveBeenCalled();
    });
  });
});
