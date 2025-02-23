import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { VideoGenerationStatus } from "@prisma/client";
import { Request, Response, Router } from "express";
import { prisma } from "../lib/prisma.js";
import { isAuthenticated } from "../middleware/auth.js";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline.js";
import { s3VideoService } from "../services/video/s3-video.service.js";
import { logger } from "../utils/logger.js";

const router = Router();
const productionPipeline = new ProductionPipeline();
const s3Client = new S3Client({ region: process.env.AWS_REGION });

interface RegeneratePhotoRequest extends Request {
  params: { photoId: string };
  user?: { id: string };
}

interface RegenerationPhoto {
  id: string;
  processedFilePath: string;
  order: number;
  filePath: string;
}

interface RegenerationContext {
  photosToRegenerate: Array<{
    id: string;
    processedFilePath: string;
    order: number;
    filePath: string;
  }>;
  existingPhotos: RegenerationPhoto[];
  regeneratedPhotoIds: string[];
  totalPhotos: number;
}

interface BatchRegenerateRequest extends Request {
  body: {
    photoIds: string[];
  };
  user?: { id: string };
}

interface JobMetadata {
  isRegeneration: boolean;
  forceRegeneration: boolean;
  regenerationContext: RegenerationContext;
}

// Single photo regeneration
router.post(
  "/:photoId/regenerate",
  isAuthenticated,
  async (req: RegeneratePhotoRequest, res: Response): Promise<void> => {
    const { photoId } = req.params;
    const userId = req.user!.id;

    logger.info("[PHOTO_REGENERATE] Request received", { photoId, userId });

    try {
      const photo = await prisma.photo.findUnique({
        where: { id: photoId, userId },
        include: {
          listing: { include: { photos: { orderBy: { order: "asc" } } } },
        },
      });

      if (!photo || !photo.listing) {
        logger.error("[PHOTO_REGENERATE] Photo or listing not found", {
          photoId,
          userId,
        });
        res
          .status(404)
          .json({ success: false, message: "Photo or listing not found" });
        return;
      }

      // Use processedFilePath or fallback to filePath
      const photoPath = photo.processedFilePath || photo.filePath;
      if (!photoPath) {
        logger.error("[PHOTO_REGENERATE] No file path available", { photoId });
        res
          .status(400)
          .json({ success: false, message: "No file path available" });
        return;
      }

      // Validate all input files are accessible
      const inputFiles = photo.listing.photos.map(
        (p) => p.processedFilePath || p.filePath
      );

      const validationResults = await Promise.all(
        inputFiles.map(async (file) => {
          if (!file) return file;
          try {
            const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
            const key = file.split("/").slice(3).join("/"); // Extract key from URL
            const exists = await s3VideoService.checkFileExists(
              bucketName,
              key
            );
            return exists ? null : file;
          } catch (error) {
            logger.error("Failed to validate input file", {
              file,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return file;
          }
        })
      );

      const invalidFiles = validationResults.filter(
        (file): file is string => file !== null
      );
      if (invalidFiles.length > 0) {
        logger.error("[PHOTO_REGENERATE] Some input files are not accessible", {
          invalidFiles,
        });
        res.status(400).json({
          success: false,
          message: "Some input files are not accessible",
          invalidFiles,
        });
        return;
      }

      const job = await prisma.videoJob.create({
        data: {
          listingId: photo.listingId,
          userId,
          status: VideoGenerationStatus.PENDING,
          template: "crescendo",
          inputFiles,
          metadata: {
            isRegeneration: true,
            forceRegeneration: true,
            regenerationContext: {
              photosToRegenerate: [
                {
                  id: photo.id,
                  processedFilePath: photoPath,
                  order: photo.order,
                  filePath: photoPath,
                },
              ],
              existingPhotos: photo.listing.photos
                .filter((p) => p.id !== photoId)
                .map((p) => ({
                  id: p.id,
                  processedFilePath: p.processedFilePath || p.filePath,
                  order: p.order,
                  filePath: p.processedFilePath || p.filePath,
                })),
              regeneratedPhotoIds: [photoId],
              totalPhotos: photo.listing.photos.length,
            },
          },
        },
      });

      logger.info("[PHOTO_REGENERATE] Job created with metadata", {
        jobId: job.id,
        photoId,
        metadata: job.metadata,
      });

      // Execute pipeline with enhanced logging
      productionPipeline
        .execute({
          jobId: job.id,
          inputFiles,
          template: "crescendo",
          coordinates: photo.listing.coordinates as
            | { lat: number; lng: number }
            | undefined,
          isRegeneration: true,
          forceRegeneration: true,
          regenerationContext: (job.metadata as unknown as JobMetadata)
            .regenerationContext,
          skipLock: false,
        })
        .catch(async (error) => {
          logger.error("[PHOTO_REGENERATE] Regeneration failed", {
            jobId: job.id,
            photoId,
            metadata: job.metadata,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          await prisma.videoJob.update({
            where: { id: job.id },
            data: {
              status: VideoGenerationStatus.FAILED,
              error: error.message,
              completedAt: new Date(),
            },
          });
        });

      res.status(202).json({
        success: true,
        message: "Photo regeneration queued",
        jobId: job.id,
      });
    } catch (error) {
      logger.error("[PHOTO_REGENERATE] Request failed", {
        photoId,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start photo regeneration",
      });
    }
  }
);

// Batch photo regeneration
router.post(
  "/regenerate",
  isAuthenticated,
  async (req: BatchRegenerateRequest, res: Response): Promise<void> => {
    const { photoIds } = req.body;
    const userId = req.user!.id;

    logger.info("[BATCH_REGENERATE] Request received", {
      photoIds,
      userId,
    });

    try {
      // First fetch the photo that needs regeneration
      const photoToRegenerate = await prisma.photo.findFirst({
        where: {
          id: photoIds[0],
          userId,
        },
        select: {
          id: true,
          processedFilePath: true,
          filePath: true,
          order: true,
          listingId: true,
        },
      });

      if (!photoToRegenerate) {
        logger.error("[BATCH_REGENERATE] Photo not found", {
          photoId: photoIds[0],
          userId,
        });
        res.status(404).json({
          success: false,
          error: "Photo not found",
        });
        return;
      }

      // Get all other photos from the listing with runwayVideoPath
      const existingPhotos = await prisma.photo.findMany({
        where: {
          listingId: photoToRegenerate.listingId,
          id: { not: photoToRegenerate.id },
          runwayVideoPath: { not: null }, // Only get photos with existing runway videos
        },
        select: {
          id: true,
          processedFilePath: true,
          filePath: true,
          order: true,
          runwayVideoPath: true,
        },
        orderBy: { order: "asc" },
      });

      const regenerationContext = {
        photosToRegenerate: [
          {
            id: photoToRegenerate.id,
            processedFilePath:
              photoToRegenerate.processedFilePath || photoToRegenerate.filePath,
            order: photoToRegenerate.order,
            filePath:
              photoToRegenerate.processedFilePath || photoToRegenerate.filePath,
          },
        ],
        existingPhotos: existingPhotos.map((p) => ({
          id: p.id,
          processedFilePath: p.processedFilePath || p.filePath,
          order: p.order,
          filePath: p.processedFilePath || p.filePath,
          runwayVideoPath: p.runwayVideoPath,
        })),
        regeneratedPhotoIds: [photoToRegenerate.id],
        totalPhotos: existingPhotos.length + 1,
      };

      // Create video job with explicit metadata
      const job = await prisma.videoJob.create({
        data: {
          listingId: photoToRegenerate.listingId,
          userId,
          status: VideoGenerationStatus.PENDING,
          template: "crescendo",
          inputFiles: [
            photoToRegenerate.processedFilePath || photoToRegenerate.filePath,
          ],
          metadata: {
            isRegeneration: true,
            forceRegeneration: true,
            regenerationContext,
          },
        },
      });

      logger.info("[BATCH_REGENERATE] Job created with metadata", {
        jobId: job.id,
        listingId: photoToRegenerate.listingId,
        metadata: job.metadata,
      });

      // Execute pipeline with enhanced logging
      setImmediate(async () => {
        try {
          const listing = await prisma.listing.findUnique({
            where: { id: photoToRegenerate.listingId },
            select: { coordinates: true },
          });

          logger.info("[BATCH_REGENERATE] Starting pipeline execution", {
            jobId: job.id,
            listingId: photoToRegenerate.listingId,
            metadata: job.metadata,
            inputFiles: job.inputFiles,
          });

          await productionPipeline.execute({
            jobId: job.id,
            listingId: photoToRegenerate.listingId,
            inputFiles: job.inputFiles as unknown as string[],
            template: "crescendo",
            coordinates: listing?.coordinates as
              | { lat: number; lng: number }
              | undefined,
            isRegeneration: true,
            forceRegeneration: true,
            regenerationContext: (job.metadata as unknown as JobMetadata)
              .regenerationContext,
            skipLock: false,
          });
        } catch (error) {
          logger.error("[BATCH_REGENERATE] Pipeline execution failed", {
            jobId: job.id,
            listingId: photoToRegenerate.listingId,
            error: error instanceof Error ? error.message : "Unknown error",
          });

          await prisma.videoJob.update({
            where: { id: job.id },
            data: {
              status: VideoGenerationStatus.FAILED,
              error: error instanceof Error ? error.message : "Unknown error",
              completedAt: new Date(),
            },
          });
        }
      });

      res.status(202).json({
        success: true,
        message: "Photo regeneration queued",
        jobs: [
          {
            id: job.id,
            listingId: photoToRegenerate.listingId,
          },
        ],
        photoCount: 1,
      });
    } catch (error) {
      logger.error("[BATCH_REGENERATE] Request failed", {
        photoIds,
        userId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to start batch regeneration",
      });
    }
  }
);

// Update photo status (unchanged)
router.post(
  "/:photoId/status",
  isAuthenticated,
  async (req: Request, res: Response): Promise<void> => {
    logger.info("[PHOTO_STATUS_UPDATE] Received request", {
      photoId: req.params.photoId,
      userId: req.user?.id,
      body: req.body,
    });

    try {
      const { photoId } = req.params;
      const { s3Key, status, error } = req.body;
      const userId = req.user!.id;

      const photo = await prisma.photo.findUnique({
        where: { id: photoId, userId },
        include: {
          listing: { include: { photos: { orderBy: { order: "asc" } } } },
        },
      });

      if (!photo || !photo.listing) {
        logger.error("[PHOTO_STATUS_UPDATE] Photo not found or access denied", {
          photoId,
          userId,
        });
        res.status(404).json({
          success: false,
          message: "Photo not found or access denied",
        });
        return;
      }

      await prisma.photo.update({
        where: { id: photoId },
        data: { status, error: error || null, processedFilePath: s3Key },
      });

      const allPhotos = photo.listing.photos;
      const allUploaded = allPhotos.every((p) => p.processedFilePath);

      if (allUploaded) {
        const job = await prisma.videoJob.create({
          data: {
            listingId: photo.listingId,
            userId,
            status: VideoGenerationStatus.PROCESSING,
            template: "crescendo",
          },
        });

        productionPipeline
          .execute({
            jobId: job.id,
            inputFiles: allPhotos.map(
              (p) =>
                `s3://${process.env.AWS_BUCKET || "reelty-prod-storage"}/${
                  p.processedFilePath
                }`
            ),
            template: "crescendo",
            coordinates: photo.listing.coordinates as any,
          })
          .catch((error) => {
            logger.error("[PHOTO_STATUS_UPDATE] Pipeline execution failed", {
              jobId: job.id,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          });

        res.status(200).json({
          success: true,
          message: "Photo status updated and video generation started",
          jobId: job.id,
        });
      } else {
        res.status(200).json({
          success: true,
          message: "Photo status updated",
        });
      }
    } catch (error) {
      logger.error("[PHOTO_STATUS_UPDATE] Request failed", {
        photoId: req.params.photoId,
        userId: req.user?.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      res.status(500).json({
        success: false,
        message: "Failed to update photo status",
      });
    }
  }
);

// Verify photos (unchanged)
router.post("/verify", async (req: Request, res: Response) => {
  const { photos } = req.body;

  if (!Array.isArray(photos)) {
    res.status(400).json({ success: false, error: "Invalid photos array" });
    return;
  }

  try {
    const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
    logger.info("[Photos] Starting verification", {
      photoCount: photos.length,
      photos: photos.map((p) => ({ id: p.id, s3Key: p.s3Key })),
    });

    await Promise.all(
      photos.map(async (photo) => {
        const command = new HeadObjectCommand({
          Bucket: bucketName,
          Key: photo.s3Key,
        });
        try {
          await s3Client.send(command);
          logger.info("[Photos] Verified photo exists", {
            photoId: photo.id,
            s3Key: photo.s3Key,
          });
        } catch (error) {
          logger.error("[Photos] Failed to verify photo", {
            photoId: photo.id,
            s3Key: photo.s3Key,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          throw new Error(
            `Photo ${photo.id} not found in S3 (key: ${photo.s3Key})`
          );
        }
      })
    );

    res.json({ success: true });
  } catch (error) {
    logger.error("[Photos] Verification failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to verify photos",
    });
  }
});

export default router;
