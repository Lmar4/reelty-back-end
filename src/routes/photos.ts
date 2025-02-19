import { Router, Request, Response } from "express";
import { isAuthenticated } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";
import { VideoGenerationStatus } from "@prisma/client";
import { logger } from "../utils/logger";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const router = Router();
const productionPipeline = new ProductionPipeline();
const s3Client = new S3Client({ region: process.env.AWS_REGION });

interface RegeneratePhotoRequest extends Request {
  params: {
    photoId: string;
  };
  user?: {
    id: string;
  };
}

interface Photo {
  id: string;
  listingId: string;
  listing?: Listing;
  processedFilePath?: string | null;
}

interface Listing {
  id: string;
  photos?: Photo[];
}

interface VideoJob {
  id: string;
  listingId: string;
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
          listing: true,
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

      // Create a new job for regeneration
      const job = await prisma.videoJob.create({
        data: {
          listingId: photo.listingId,
          userId,
          status: VideoGenerationStatus.PROCESSING,
          template: "crescendo",
        },
      });

      logger.info("[PHOTO_REGENERATE] Created video job", {
        photoId,
        jobId: job.id,
        listingId: photo.listingId,
      });

      // Start the regeneration process using regeneratePhotos
      productionPipeline.regeneratePhotos(job.id, [photoId]).catch((error) => {
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

// Batch regenerate photos
router.post(
  "/regenerate",
  isAuthenticated,
  async (req: Request, res: Response): Promise<void> => {
    logger.info("[PHOTOS_BATCH_REGENERATE] Received request", {
      userId: req.user?.id,
      body: req.body,
    });

    try {
      const { photoIds } = req.body;
      const userId = req.user!.id;

      const MAX_BATCH_SIZE = 20;

      if (!Array.isArray(photoIds) || photoIds.length === 0) {
        res.status(400).json({
          success: false,
          message: "Invalid photo IDs array",
        });
        return;
      }

      if (photoIds.length > MAX_BATCH_SIZE) {
        res.status(400).json({
          success: false,
          message: `Cannot process more than ${MAX_BATCH_SIZE} photos at once`,
        });
        return;
      }

      // Find all photos and check ownership
      const photos = await prisma.photo.findMany({
        where: {
          id: { in: photoIds },
          userId,
        },
        include: {
          listing: true,
        },
      });

      // Find which photos were not accessible
      const foundPhotoIds = new Set(photos.map((photo) => photo.id));
      const inaccessiblePhotoIds = photoIds.filter(
        (id) => !foundPhotoIds.has(id)
      );

      if (photos.length === 0) {
        logger.error(
          "[PHOTOS_BATCH_REGENERATE] No photos found or access denied",
          {
            photoIds,
            userId,
          }
        );
        res.status(404).json({
          success: false,
          message: "No photos found or access denied",
          data: {
            inaccessiblePhotoIds: photoIds,
          },
        });
        return;
      }

      // Group photos by listing
      const photosByListing = photos.reduce<
        Record<string, { listing: Listing; photos: Photo[] }>
      >((acc, photo) => {
        if (!photo.listing) return acc;
        if (!acc[photo.listingId]) {
          acc[photo.listingId] = {
            listing: photo.listing,
            photos: [],
          };
        }
        acc[photo.listingId].photos.push(photo);
        return acc;
      }, {});

      // Create jobs for each listing and use regeneratePhotos
      const jobs = await Promise.all(
        Object.entries(photosByListing).map(
          async ([listingId, { listing, photos }]: [
            string,
            { listing: Listing; photos: Photo[] }
          ]) => {
            // Create a new job for regeneration
            const job = await prisma.videoJob.create({
              data: {
                listingId,
                userId,
                status: VideoGenerationStatus.PROCESSING,
                template: "crescendo",
              },
            });

            logger.info("[PHOTOS_BATCH_REGENERATE] Created video job", {
              jobId: job.id,
              listingId,
              photosToRegenerate: photos.map((p: Photo) => p.id),
            });

            // Use regeneratePhotos instead of execute
            productionPipeline
              .regeneratePhotos(
                job.id,
                photos.map((p: Photo) => p.id)
              )
              .catch((error) => {
                logger.error(
                  "[PHOTOS_BATCH_REGENERATE_ERROR] Pipeline execution failed",
                  {
                    jobId: job.id,
                    error:
                      error instanceof Error ? error.message : "Unknown error",
                    stack: error instanceof Error ? error.stack : undefined,
                  }
                );
              });

            return job;
          }
        )
      );

      logger.info("[PHOTOS_BATCH_REGENERATE] Sending success response", {
        jobIds: jobs.map((job: VideoJob) => job.id),
        inaccessiblePhotoIds,
      });

      res.status(200).json({
        success: true,
        message: "Photo regeneration started",
        data: {
          jobs: jobs.map((job: VideoJob) => ({
            id: job.id,
            listingId: job.listingId,
          })),
          inaccessiblePhotoIds,
        },
      });
    } catch (error) {
      logger.error("[PHOTOS_BATCH_REGENERATE_ERROR] Request failed", {
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

// Update photo status after S3 upload
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
        logger.error("[PHOTO_STATUS_UPDATE] Photo not found or access denied", {
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

      // Update photo status
      await prisma.photo.update({
        where: { id: photoId },
        data: {
          status,
          error: error || null,
          processedFilePath: s3Key, // Store the S3 key for the uploaded photo
        },
      });

      // Check if all photos in the listing are uploaded
      const allPhotos = photo.listing.photos;
      const allUploaded = allPhotos.every((p) => p.processedFilePath);

      if (allUploaded) {
        // Create a new job for regeneration
        const job = await prisma.videoJob.create({
          data: {
            listingId: photo.listingId,
            userId,
            status: VideoGenerationStatus.PROCESSING,
            template: "crescendo",
          },
        });

        // Start the video generation pipeline
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
              stack: error instanceof Error ? error.stack : undefined,
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

router.post("/verify", async (req: Request, res: Response) => {
  const { photos } = req.body;

  if (!Array.isArray(photos)) {
    res.status(400).json({
      success: false,
      error: "Invalid photos array",
    });
    return;
  }

  try {
    const bucketName = process.env.AWS_BUCKET;
    if (!bucketName) {
      throw new Error("AWS_BUCKET environment variable is not set");
    }

    logger.info("[Photos] Starting verification", {
      photoCount: photos.length,
      photos: photos.map((p) => ({ id: p.id, s3Key: p.s3Key })),
    });

    // Check each photo exists in S3
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
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to verify photos",
    });
  }
});

export default router;
