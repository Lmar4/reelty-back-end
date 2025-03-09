import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import express, { Request, Response } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middleware/auth.js";
import { validateRequest } from "../middleware/validate.js";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline.js";
import { logger } from "../utils/logger.js";

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

// Add type definition at the top of the file
interface Coordinates {
  lat: number;
  lng: number;
}

// Add this validation helper at the top of the file
const validateUUID = (id: string | undefined): boolean => {
  if (!id) return false;
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(id);
};

// Add type guard at the top of the file
function isCoordinates(obj: any): obj is Coordinates {
  return (
    obj &&
    typeof obj === "object" &&
    "lat" in obj &&
    typeof obj.lat === "number" &&
    "lng" in obj &&
    typeof obj.lng === "number"
  );
}

// Add this helper function at the top of the file
function validateListingData(
  listingId: string | undefined,
  jobId: string | undefined
): void {
  if (!listingId) {
    throw new Error("Missing listing ID");
  }
  if (!jobId) {
    throw new Error("Missing job ID");
  }
  if (!validateUUID(listingId)) {
    throw new Error(`Invalid listing ID format: ${listingId}`);
  }
  if (!validateUUID(jobId)) {
    throw new Error(`Invalid job ID format: ${jobId}`);
  }
}

// Add this function after the validateListingData function
async function checkUserListingLimit(userId: string): Promise<{
  canCreate: boolean;
  currentCount: number;
  maxAllowed: number;
  currentTier: string;
}> {
  // Get user's current subscription tier
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      activeSubscription: {
        include: {
          tier: true,
        },
      },
      listings: {
        where: {
          status: "ACTIVE",
        },
      },
    },
  });

  if (!user || !user.activeSubscription?.tier) {
    throw new Error("User or subscription tier not found");
  }

  const currentCount = user.listings.length;
  const maxAllowed = user.activeSubscription.tier.maxActiveListings;
  const currentTier = user.activeSubscription.tier.name;

  return {
    canCreate: currentCount < maxAllowed,
    currentCount,
    maxAllowed,
    currentTier,
  };
}

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
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "User not authenticated" });
      return;
    }

    // Start a transaction to ensure both operations succeed or fail together
    const result = await prisma.$transaction(async (tx) => {
      // First check if user has available credits
      const availableCredits = await tx.listingCredit.findMany({
        where: {
          userId,
          creditsRemaining: { gt: 0 },
        },
      });

      const totalCredits = availableCredits.reduce(
        (sum, credit) => sum + credit.creditsRemaining,
        0
      );

      if (totalCredits < 1) {
        throw new Error("Insufficient credits");
      }

      // Create the listing
      const listing = await tx.listing.create({
        data: {
          userId,
          address: req.body.address,
          description: req.body.description,
          coordinates: req.body.coordinates || null,
          photoLimit: req.body.photoLimit || 10,
          status: "ACTIVE",
        },
      });

      // Deduct one credit
      const oldestCredit = availableCredits[0];
      await tx.listingCredit.update({
        where: { id: oldestCredit.id },
        data: {
          creditsRemaining: oldestCredit.creditsRemaining - 1,
        },
      });

      // Log the credit usage
      await tx.creditLog.create({
        data: {
          userId,
          amount: -1,
          reason: `Created listing ${listing.id}`,
        },
      });

      return listing;
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[CREATE_LISTING_ERROR]", error);
    if (error instanceof Error && error.message === "Insufficient credits") {
      res.status(400).json({
        success: false,
        error: "Insufficient credits to create listing",
        details: {
          message: "You need to purchase more credits to create a new listing.",
        },
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: "Failed to create listing",
      message: error instanceof Error ? error.message : "Unknown error",
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

      // Check for duplicate S3 key
      const existingPhoto = await tx.photo.findFirst({
        where: { s3Key, listingId },
      });

      if (existingPhoto) {
        logger.error("[Listings] Duplicate S3 key detected", {
          s3Key,
          listingId,
          existingPhotoId: existingPhoto.id,
        });
        throw new Error(`Duplicate S3 key: ${s3Key}`);
      }

      const photo = await tx.photo.create({
        data: {
          userId,
          listingId,
          filePath,
          s3Key,
          order,
          status: "PENDING",
        },
      });

      logger.info("[Listings] Photo record created with PENDING status", {
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
            logger.info(
              "[Listings] Starting pipeline execution for uploaded photo",
              {
                jobId: job.id,
                listingId: listingId,
                inputFilesCount: updatedListing.photos.length,
              }
            );

            productionPipeline
              .execute({
                jobId: job.id,
                listingId: listingId,
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
                    listingId,
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
  const userId = req.user!.id;

  try {
    // Verify the listing belongs to the authenticated user
    const listing = await prisma.listing.findUnique({
      where: {
        id: listingId,
        userId,
      },
    });

    if (!listing) {
      logger.error("[LISTING_DELETE] Listing not found or access denied", {
        listingId,
        userId,
      });
      res.status(404).json({
        success: false,
        error: "Listing not found or access denied",
      });
      return;
    }

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
      const { s3Key } = photo;
      if (!s3Key) {
        logger.error("[Listings] Missing required photo data", {
          listingId,
          hasS3Key: false,
        });
        continue;
      }

      // Check for duplicate S3 key
      const existingPhoto = await prisma.photo.findFirst({
        where: { s3Key, listingId },
      });

      if (existingPhoto) {
        logger.error("[Listings] Duplicate S3 key detected", {
          s3Key,
          listingId,
          existingPhotoId: existingPhoto.id,
        });
        continue;
      }

      const filePath = `https://${process.env.AWS_BUCKET}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${s3Key}`;

      try {
        // Let Prisma generate the ID automatically
        const photoRecord = await prisma.photo.create({
          data: {
            userId,
            listingId,
            s3Key,
            filePath,
            status: "PENDING",
            order: processedPhotos.length,
          },
        });
        processedPhotos.push(photoRecord as PhotoRecord);

        logger.info("[Listings] Photo processed successfully", {
          photoId: photoRecord.id,
          listingId: listing.id,
          filePath,
        });
      } catch (photoError) {
        logger.error("[Listings] Failed to create photo record", {
          error: photoError,
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

      // Log only essential information about found videos
      // logger.info("[LATEST_VIDEOS] Found videos", {
      //   videoCount: videos.length,
      //   latestVideo: videos[0]
      //     ? {
      //         id: videos[0].id,
      //         status: videos[0].status,
      //         template: videos[0].template,
      //       }
      //     : null,
      // });

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

      // Log only summary statistics
      // logger.info("[LATEST_VIDEOS] Request completed", {
      //   processingCount,
      //   failedCount,
      //   completedCount,
      //   totalCount: videos.length,
      //   shouldEndPolling,
      // });
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
