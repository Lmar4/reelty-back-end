import { Router, Request, Response } from "express";
import { isAuthenticated } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";
import { VideoGenerationStatus } from "@prisma/client";
import { logger } from "../utils/logger";

const router = Router();
const productionPipeline = new ProductionPipeline();

interface RegeneratePhotoRequest extends Request {
  params: {
    photoId: string;
  };
  user?: {
    id: string;
  };
}

// Regenerate photo and its associated video
router.post(
  "/:photoId/regenerate",
  isAuthenticated,
  async (req: RegeneratePhotoRequest, res: Response): Promise<void> => {
    logger.info("[PHOTO_REGENERATE] Received request", {
      photoId: req.params.photoId,
      userId: req.user?.id,
      headers: req.headers,
    });

    try {
      const { photoId } = req.params;
      const userId = req.user!.id;

      logger.info("[PHOTO_REGENERATE] Finding photo", {
        photoId,
        userId,
      });

      // Find the photo and check ownership
      const photo = await prisma.photo.findUnique({
        where: {
          id: photoId,
          userId,
        },
        include: {
          listing: {
            include: {
              photos: {
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
        },
      });

      if (!photo || !photo.listing) {
        logger.error("[PHOTO_REGENERATE] Photo not found or access denied", {
          photoId,
          userId,
          photoExists: !!photo,
          listingExists: !!photo?.listing,
        });
        res.status(404).json({
          success: false,
          message: "Photo not found or access denied",
        });
        return;
      }

      logger.info("[PHOTO_REGENERATE] Found photo, updating status", {
        photoId,
        listingId: photo.listingId,
      });

      // Start regeneration process
      await prisma.photo.update({
        where: { id: photoId },
        data: { status: "processing", error: null },
      });

      // Create a new job for regeneration
      const job = await prisma.videoJob.create({
        data: {
          listingId: photo.listingId,
          userId,
          status: VideoGenerationStatus.PROCESSING,
          template: "default",
        },
      });

      logger.info("[PHOTO_REGENERATE] Created video job", {
        photoId,
        jobId: job.id,
        listingId: photo.listingId,
        photoCount: photo.listing.photos.length,
      });

      // Get all photo URLs in order
      const photoUrls = photo.listing.photos.map((p) => p.filePath);

      // Start the regeneration process in the background
      productionPipeline
        .execute({
          jobId: job.id,
          inputFiles: photoUrls,
          template: "default",
          coordinates: photo.listing.coordinates as any,
        })
        .catch((error) => {
          logger.error("[PHOTO_REGENERATE_ERROR] Pipeline execution failed", {
            jobId: job.id,
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
          });
        });

      logger.info("[PHOTO_REGENERATE] Sending success response", {
        photoId,
        jobId: job.id,
      });

      res.status(200).json({
        success: true,
        message: "Photo regeneration started",
        jobId: job.id,
      });
    } catch (error) {
      logger.error("[PHOTO_REGENERATE_ERROR] Request failed", {
        photoId: req.params.photoId,
        userId: req.user?.id,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

export default router;
