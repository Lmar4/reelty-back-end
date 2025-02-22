import { Prisma, PrismaClient, VideoGenerationStatus } from "@prisma/client";
import express, { Request, Response } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";
import { s3VideoService } from "../services/video/s3-video.service";
import { logger } from "../utils/logger";

const router = express.Router();
const prisma = new PrismaClient();
const productionPipeline = new ProductionPipeline();

// Validation schemas
const createListingSchema = z.object({
  body: z.object({
    address: z.string().min(1),
    description: z.string().optional(),
    coordinates: z
      .object({
        lat: z.number(),
        lng: z.number(),
      })
      .nullable()
      .optional(),
    photoLimit: z.number().optional(),
    photos: z
      .array(
        z.object({
          s3Key: z.string(),
          filePath: z.string().optional(),
        })
      )
      .optional(),
  }),
});

interface PhotoRecord {
  id: string;
  userId: string;
  listingId: string;
  s3Key: string;
  filePath: string;
  order: number;
  status: string;
}

// Add this validation helper at the top of the file
const validateUUID = (id: string | undefined): boolean => {
  if (!id) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id
  );
};

// Get all listings
const getListings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.query;
    const authenticatedUserId = req.user!.id;

    if (userId && userId !== authenticatedUserId) {
      res.status(403).json({ success: false, error: "Access denied" });
      return;
    }

    logger.info("[Listings] Fetching listings", {
      userId: authenticatedUserId,
    });

    const listings = await prisma.listing.findMany({
      where: { userId: authenticatedUserId },
      include: {
        photos: true,
        videoJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: listings });
  } catch (error) {
    logger.error("[Listings] Error fetching listings", { error });
    res.status(500).json({ success: false, error: "Unknown error occurred" });
  }
};

// Get listing by ID
const getListing = async (req: Request, res: Response): Promise<void> => {
  try {
    const { listingId } = req.params;
    const userId = req.user!.id;

    logger.info("[Listings] Fetching single listing", { listingId, userId });

    const listing = await prisma.listing.findUnique({
      where: { id: listingId, userId },
      include: {
        photos: true,
        videoJobs: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!listing) {
      logger.error("[Listings] Listing not found or access denied", {
        listingId,
        userId,
      });
      res
        .status(404)
        .json({ success: false, error: "Listing not found or access denied" });
      return;
    }

    res.json({ success: true, data: listing });
  } catch (error) {
    logger.error("[Listings] Error fetching listing", { error });
    res.status(500).json({ success: false, error: "Unknown error occurred" });
  }
};

// Create new listing
const createListing = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { address, description, coordinates, photoLimit, photos } = req.body;

    logger.info("[Listings] Creating new listing", {
      userId,
      address,
      hasCoordinates: !!coordinates,
      photoLimit,
      photoCount: photos?.length || 0,
      body: req.body,
    });

    if (
      coordinates &&
      (typeof coordinates.lat !== "number" ||
        typeof coordinates.lng !== "number")
    ) {
      res
        .status(400)
        .json({ success: false, error: "Invalid coordinates format" });
      return;
    }

    // Validate photo URLs if provided
    if (Array.isArray(photos) && photos.length > 0) {
      // Check for duplicate S3 keys first
      const s3Keys = photos.map((photo) => photo.s3Key);
      const existingPhotos = await prisma.photo.findMany({
        where: { s3Key: { in: s3Keys } },
        select: { s3Key: true },
      });

      if (existingPhotos.length > 0) {
        const duplicateKeys = existingPhotos.map((p) => p.s3Key);
        logger.error("[Listings] Duplicate S3 keys detected", {
          duplicateKeys,
          userId,
        });
        res.status(400).json({
          success: false,
          error: "Duplicate S3 keys detected",
          duplicateKeys,
        });
        return;
      }

      // Validate S3 URLs
      const invalidUrls = await Promise.all(
        photos.map(async (photo) => {
          const { s3Key } = photo;
          try {
            const exists = await s3VideoService.checkFileExists(
              process.env.AWS_BUCKET || "reelty-prod-storage",
              s3Key
            );
            return exists ? null : s3Key;
          } catch (error) {
            logger.error("Failed to validate photo URL", {
              s3Key,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return s3Key;
          }
        })
      );

      const failedUrls = invalidUrls.filter(
        (url): url is string => url !== null
      );
      if (failedUrls.length > 0) {
        res.status(400).json({
          success: false,
          error: "Some photo URLs are not accessible",
          failedUrls,
        });
        return;
      }
    }

    // Simplified transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Create the listing first
        const listing = await tx.listing.create({
          data: {
            userId,
            address,
            description,
            coordinates: coordinates || null,
            photoLimit: photoLimit || 10,
            status: "ACTIVE",
          },
        });

        logger.info("[Listings] Created listing", {
          listingId: listing.id,
          userId,
        });

        // 2. Create photos if any
        const photoRecords: PhotoRecord[] = [];
        if (Array.isArray(photos) && photos.length > 0) {
          // Double-check for duplicate S3 keys within transaction
          const s3Keys = photos.map((photo) => photo.s3Key);
          const existingPhotos = await tx.photo.findMany({
            where: { s3Key: { in: s3Keys } },
            select: { s3Key: true },
          });

          if (existingPhotos.length > 0) {
            throw new Error(
              `Duplicate S3 keys detected: ${existingPhotos
                .map((p) => p.s3Key)
                .join(", ")}`
            );
          }

          for (const photo of photos) {
            const { s3Key } = photo;
            const filePath = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

            // Validate listing.id is a valid UUID
            if (
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                listing.id
              )
            ) {
              throw new Error(
                `Invalid UUID format for listing ID: ${listing.id}`
              );
            }

            try {
              const photoRecord: PhotoRecord = await tx.photo.create({
                data: {
                  userId,
                  listingId: listing.id,
                  s3Key,
                  filePath,
                  order: photoRecords.length,
                  status: "completed",
                },
              });
              photoRecords.push(photoRecord);
            } catch (photoError) {
              logger.error("[Listings] Failed to create photo record", {
                error:
                  photoError instanceof Error
                    ? photoError.message
                    : "Unknown error",
                s3Key,
                listingId: listing.id,
              });
              throw new Error(
                `Failed to create photo record for S3 key: ${s3Key}`
              );
            }
          }
        }

        // 3. Create video job if we have photos
        let videoJob = null;
        if (photoRecords.length > 0) {
          const inputFiles = photoRecords.map((photo) => photo.filePath);

          // Validate all input files are accessible
          const validationResults = await Promise.all(
            inputFiles.map(async (file) => {
              try {
                const bucketName =
                  process.env.AWS_BUCKET || "reelty-prod-storage";
                const key = file.split("/").slice(3).join("/");
                const exists = await s3VideoService.checkFileExists(
                  bucketName,
                  key
                );
                return exists ? null : file;
              } catch (error) {
                logger.error("Failed to validate input file", {
                  file,
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                });
                return file;
              }
            })
          );

          const invalidFiles = validationResults.filter(
            (file): file is string => file !== null
          );
          if (invalidFiles.length > 0) {
            throw new Error(
              `Some input files are not accessible: ${invalidFiles.join(", ")}`
            );
          }

          videoJob = await tx.videoJob.create({
            data: {
              listingId: listing.id,
              userId,
              status: VideoGenerationStatus.PENDING,
              template: "crescendo",
              inputFiles,
              position: 0,
              priority: 1,
            },
          });

          // Schedule pipeline execution after transaction
          setImmediate(async () => {
            try {
              if (!validateUUID(listing.id)) {
                logger.error(
                  "[Listings] Invalid listing ID before pipeline execution",
                  {
                    listingId: listing.id,
                    jobId: videoJob!.id,
                  }
                );
                throw new Error("Invalid listing ID format");
              }

              await productionPipeline.execute({
                jobId: videoJob!.id,
                listingId: listing.id,
                inputFiles,
                template: "crescendo",
                coordinates,
                skipRunwayIfCached: true,
              });
            } catch (error) {
              logger.error(
                `[Listings] Pipeline execution failed for job ${videoJob!.id}`,
                {
                  error,
                  listingId: listing.id,
                }
              );

              // Update job status on failure
              await prisma.videoJob.update({
                where: { id: videoJob!.id },
                data: {
                  status: VideoGenerationStatus.FAILED,
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                  completedAt: new Date(),
                },
              });
            }
          });
        }

        return {
          listing,
          photos: photoRecords,
          jobId: videoJob?.id || null,
        };
      },
      {
        maxWait: 30000, // 30 seconds max wait
        timeout: 300000, // 5 minutes total timeout
      }
    );

    logger.info("[Listings] Created successfully", {
      listingId: result.listing.id,
      photoCount: result.photos.length,
      jobId: result.jobId,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error("[Listings] Error creating listing", {
      error: error instanceof Error ? error.message : "Unknown error",
      body: req.body,
    });

    // Better error handling
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2023") {
        res.status(400).json({
          success: false,
          error: "Invalid ID format in request",
        });
        return;
      }
    }

    // Handle specific error messages
    if (error instanceof Error) {
      if (error.message.includes("Duplicate S3 keys")) {
        res.status(400).json({
          success: false,
          error: error.message,
        });
        return;
      }
      if (error.message.includes("Invalid UUID format")) {
        res.status(400).json({
          success: false,
          error: error.message,
        });
        return;
      }
    }

    res.status(500).json({
      success: false,
      error: "Failed to create listing",
    });
  }
};

// Upload photo to listing
const uploadPhoto = async (req: Request, res: Response): Promise<void> => {
  try {
    const { listingId } = req.params;
    const userId = req.user!.id;
    const { s3Key, order: orderStr } = req.body;
    const order = parseInt(orderStr || "0", 10);

    if (!s3Key) {
      res.status(400).json({ success: false, error: "s3Key is required" });
      return;
    }

    const filePath = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

    logger.info("[LISTINGS] Processing photo upload:", {
      listingId,
      userId,
      s3Key,
      filePath,
      order,
    });

    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.listing.findUnique({
        where: { id: listingId, userId },
        include: { photos: true },
      });

      if (!listing) {
        throw new Error("Listing not found or access denied");
      }

      const photo = await tx.photo.create({
        data: {
          userId,
          listingId,
          filePath,
          s3Key,
          order,
          status: "completed",
        },
      });

      logger.info("[Listings] Photo record created", {
        photoId: photo.id,
        listingId,
        filePath,
        s3Key,
        order,
      });

      const updatedListing = await tx.listing.findUnique({
        where: { id: listingId },
        include: { photos: true },
      });

      if (!updatedListing) throw new Error("Failed to fetch updated listing");

      let jobId = null;
      if (updatedListing.photos.length > 0) {
        // Check for existing pending or processing jobs
        const existingJob = await tx.videoJob.findFirst({
          where: {
            listingId,
            status: {
              in: [
                VideoGenerationStatus.PENDING,
                VideoGenerationStatus.PROCESSING,
              ],
            },
          },
        });

        if (existingJob) {
          logger.info(
            `[Listings] Found existing job for listing ${listingId}`,
            {
              jobId: existingJob.id,
            }
          );
          jobId = existingJob.id;
        } else {
          // Create the video job within the transaction
          const job = await tx.videoJob.create({
            data: {
              listingId,
              userId,
              status: VideoGenerationStatus.PENDING,
              template: "crescendo",
              inputFiles: updatedListing.photos.map((p) => p.filePath),
            },
          });
          jobId = job.id;

          // Schedule the pipeline execution AFTER the transaction
          setImmediate(() => {
            productionPipeline
              .execute({
                jobId: job.id,
                inputFiles: updatedListing.photos.map((p) => p.filePath),
                template: "crescendo",
                coordinates: updatedListing.coordinates as any,
                skipRunwayIfCached: true,
              })
              .catch((error) => {
                logger.error(
                  `[Listings] Pipeline execution failed for job ${job.id}`,
                  {
                    error,
                  }
                );
              });
          });
        }
      }

      return { photo, jobId };
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error("[Listings] Error uploading photo", { error });
    if (
      error instanceof Error &&
      error.message === "Listing not found or access denied"
    ) {
      res.status(404).json({ success: false, error: error.message });
    } else {
      res.status(500).json({ success: false, error: "Unknown error occurred" });
    }
  }
};

// Delete listing
const deleteListing = async (listingId: string) => {
  await prisma.videoJob.deleteMany({ where: { listingId } });
  return await prisma.listing.delete({ where: { id: listingId } });
};

const handleDeleteListing = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { listingId } = req.params;
  try {
    await deleteListing(listingId);
    res.json({ success: true });
  } catch (error) {
    logger.error("[LISTING_DELETE] Error:", { error });
    res.status(500).json({ success: false, error: "Failed to delete listing" });
  }
};

// Process photos for listing
const processPhotos = async (req: Request, res: Response) => {
  const { listingId } = req.params;
  const { photos } = req.body;
  const userId = req.user!.id;

  try {
    // Validate listingId
    if (!listingId) {
      logger.error("[Listings] Missing listingId in request params");
      res.status(400).json({ success: false, error: "Missing listingId" });
      return;
    }

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(listingId)) {
      logger.error("[Listings] Invalid UUID format for listingId", {
        listingId,
      });
      res
        .status(400)
        .json({ success: false, error: "Invalid listing ID format" });
      return;
    }

    // Validate listing exists and belongs to user
    const listing = await prisma.listing.findUnique({
      where: { id: listingId, userId },
      select: { id: true, coordinates: true },
    });

    if (!listing) {
      logger.error("[Listings] Listing not found or unauthorized", {
        listingId,
        userId,
      });
      res
        .status(404)
        .json({ success: false, error: "Listing not found or unauthorized" });
      return;
    }

    logger.info("[Listings] Processing photos", {
      listingId,
      userId,
      photoCount: photos?.length || 0,
    });

    if (!Array.isArray(photos) || photos.length === 0) {
      logger.error("[Listings] Invalid or empty photos array", { listingId });
      res
        .status(400)
        .json({ success: false, error: "Invalid or empty photos array" });
      return;
    }

    const processedPhotos: PhotoRecord[] = [];
    for (const photo of photos) {
      const { id, s3Key } = photo;
      if (!id || !s3Key) {
        logger.error("[Listings] Missing required photo data", {
          photoId: id,
          listingId,
          hasS3Key: !!s3Key,
        });
        continue;
      }

      const filePath = `https://${process.env.AWS_BUCKET}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${s3Key}`;

      try {
        const photoRecord = await prisma.photo.create({
          data: {
            id,
            userId,
            listingId,
            s3Key,
            filePath,
            status: "completed",
            order: processedPhotos.length,
          },
        });
        processedPhotos.push(photoRecord as PhotoRecord);

        logger.info("[Listings] Photo processed successfully", {
          photoId: id,
          listingId: listing.id,
          filePath,
        });
      } catch (photoError) {
        logger.error("[Listings] Failed to create photo record", {
          error: photoError,
          photoId: id,
          listingId: listing.id,
        });
      }
    }

    if (processedPhotos.length === 0) {
      logger.error("[Listings] No photos were processed successfully", {
        listingId,
      });
      res.status(400).json({
        success: false,
        error: "No photos were processed successfully",
      });
      return;
    }

    const job = await prisma.videoJob.create({
      data: {
        listingId: listing.id,
        userId,
        status: VideoGenerationStatus.PROCESSING,
        template: "crescendo",
        inputFiles: processedPhotos.map((photo) => photo.filePath),
      },
    });

    logger.info("[Listings] Starting video generation", {
      jobId: job.id,
      listingId: listing.id,
      photoCount: processedPhotos.length,
      hasCoordinates: !!listing.coordinates,
    });

    // Start pipeline execution outside of the request-response cycle
    setImmediate(() => {
      productionPipeline
        .execute({
          jobId: job.id,
          listingId: listing.id,
          inputFiles: processedPhotos.map((photo) => photo.filePath),
          template: "crescendo",
          coordinates: listing.coordinates as any,
        })
        .catch((error) => {
          logger.error("[Listings] Error starting production pipeline", {
            error,
            jobId: job.id,
            listingId: listing.id,
          });
        });
    });

    res.json({
      success: true,
      message: "Photos processed successfully",
      data: { processedPhotos, jobId: job.id },
    });
  } catch (error) {
    logger.error("[Listings] Failed to process photos:", {
      error,
      listingId,
      userId,
    });
    res.status(500).json({ success: false, error: "Failed to process photos" });
  }
};

// Get photo processing status
router.get(
  "/:listingId/photos/status",
  isAuthenticated,
  async (req: Request, res: Response) => {
    try {
      const { listingId } = req.params;
      const userId = req.user!.id;

      const photos = await prisma.photo.findMany({
        where: {
          listingId,
          userId,
        },
        select: {
          id: true,
          status: true,
          error: true,
          s3Key: true,
          filePath: true,
          processedFilePath: true,
          order: true,
        },
        orderBy: {
          order: "asc",
        },
        distinct: ["s3Key"],
      });

      const bucketName = process.env.AWS_BUCKET;
      const region = process.env.AWS_REGION;

      const processingCount = photos.filter(
        (p) => p.status === "processing"
      ).length;
      const failedCount = photos.filter(
        (p) => p.status === "error" || !!p.error
      ).length;
      const totalCount = photos.length;

      const transformedPhotos = photos.map((photo) => {
        const s3Url = photo.s3Key.startsWith("https://")
          ? photo.s3Key
          : `https://${bucketName}.s3.${region}.amazonaws.com/${photo.s3Key}`;
        return {
          id: photo.id,
          url: s3Url,
          status: photo.status,
          hasError: !!photo.error,
          order: photo.order,
        };
      });

      res.json({
        success: true,
        data: {
          processingCount,
          failedCount,
          totalCount,
          photos: transformedPhotos,
        },
      });
    } catch (error) {
      logger.error("[PHOTOS_STATUS_ERROR]", { error });
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch photo status" });
    }
  }
);

// Get latest videos
router.get(
  "/:listingId/latest-videos",
  isAuthenticated,
  async (req: Request, res: Response) => {
    try {
      const { listingId } = req.params;
      const userId = req.user!.id;

      logger.info("[LATEST_VIDEOS] Starting request", { listingId, userId });

      if (!listingId || listingId === "undefined") {
        logger.error("[LATEST_VIDEOS] Invalid listingId", {
          listingId,
          userId,
        });
        res.status(400).json({ success: false, error: "Invalid listing ID" });
        return;
      }

      const videos = await prisma.videoJob.findMany({
        where: { listingId, userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          template: true,
          outputFile: true,
          thumbnailUrl: true,
          createdAt: true,
          metadata: true,
          progress: true,
          listingId: true,
          inputFiles: true,
          updatedAt: true,
        },
      });

      logger.info("[LATEST_VIDEOS] Found videos", {
        videoCount: videos.length,
        videos: videos.map((v) => ({
          id: v.id,
          template: v.template,
          status: v.status,
          createdAt: v.createdAt,
          metadata: v.metadata,
        })),
      });

      const processingCount = videos.filter(
        (v) => v.status === VideoGenerationStatus.PROCESSING
      ).length;
      const failedCount = videos.filter(
        (v) => v.status === VideoGenerationStatus.FAILED
      ).length;
      const completedCount = videos.filter(
        (v) => v.status === VideoGenerationStatus.COMPLETED
      ).length;
      const shouldEndPolling = processingCount === 0 && videos.length > 0;

      res.json({
        success: true,
        data: {
          videos,
          status: {
            isProcessing: processingCount > 0,
            processingCount,
            failedCount,
            completedCount,
            totalCount: videos.length,
            shouldEndPolling,
          },
        },
      });

      logger.info("[LATEST_VIDEOS] Sending response", {
        processingCount,
        failedCount,
        completedCount,
        totalCount: videos.length,
        shouldEndPolling,
        videoTemplates: videos.map((v) => v.template),
      });
    } catch (error) {
      logger.error("[LATEST_VIDEOS] Error:", { error });
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch latest videos" });
    }
  }
);

// Routes
router.get("/", isAuthenticated, getListings);
router.get("/:listingId", isAuthenticated, getListing);
router.post(
  "/",
  isAuthenticated,
  validateRequest(createListingSchema),
  createListing
);
router.post("/:listingId/photos", isAuthenticated, uploadPhoto);
router.delete("/:listingId", isAuthenticated, handleDeleteListing);
router.post("/:listingId/process-photos", isAuthenticated, processPhotos);

export default router;
