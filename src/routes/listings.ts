import { Prisma, PrismaClient } from "@prisma/client";
import express, { Request, Response } from "express";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { isAuthenticated } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";
import { StorageService } from "../services/storage";
import { s3VideoService } from "../services/video/s3-video.service";
import { logger } from "../utils/logger";

const router = express.Router();
const prisma = new PrismaClient();
const storageService = StorageService.getInstance();
const upload = multer();
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
  }),
});

// Upload photo validation schema
const uploadPhotoSchema = z.object({
  body: z.object({
    file: z.any(), // We'll validate this manually since it's a file
    order: z.number().optional(),
  }),
});

// Get all listings
const getListings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.query;
    const authenticatedUserId = req.user!.id;

    // Only allow users to see their own listings unless they're an admin
    if (userId && userId !== authenticatedUserId) {
      res.status(403).json({
        success: false,
        error: "Access denied",
      });
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
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    logger.info("[Listings] Found listings", {
      count: listings.length,
      userId: authenticatedUserId,
    });

    res.json({
      success: true,
      data: listings,
    });
  } catch (error) {
    logger.error("[Listings] Error fetching listings", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get listing by ID
const getListing = async (req: Request, res: Response): Promise<void> => {
  try {
    const { listingId } = req.params;
    const userId = req.user!.id;

    logger.info("[Listings] Fetching single listing", {
      listingId,
      userId,
    });

    const listing = await prisma.listing.findUnique({
      where: {
        id: listingId,
        userId, // Ensure listing belongs to authenticated user
      },
      include: {
        photos: true,
        videoJobs: {
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!listing) {
      logger.error("[Listings] Listing not found or access denied", {
        listingId,
        userId,
      });
      res.status(404).json({
        success: false,
        error: "Listing not found or access denied",
      });
      return;
    }

    logger.info("[Listings] Found listing", {
      listingId,
      userId,
    });

    res.json({
      success: true,
      data: listing,
    });
  } catch (error) {
    logger.error("[Listings] Error fetching listing", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Create new listing
const createListing = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { address, description, coordinates, photoLimit } = req.body;

    logger.info("[Listings] Creating new listing", {
      userId,
      address,
      hasCoordinates: !!coordinates,
      photoLimit,
      body: req.body,
    });

    // Validate coordinates if provided
    if (
      coordinates &&
      (typeof coordinates.lat !== "number" ||
        typeof coordinates.lng !== "number")
    ) {
      res.status(400).json({
        success: false,
        error: "Invalid coordinates format. Expected numbers for lat and lng",
      });
      return;
    }

    const listingData: Prisma.ListingUncheckedCreateInput = {
      userId,
      address,
      description,
      coordinates: coordinates || null,
      photoLimit: photoLimit || 10,
      status: "ACTIVE",
    };

    const listing = await prisma.listing.create({
      data: listingData,
      include: {
        photos: true,
      },
    });

    logger.info("[Listings] Created successfully", {
      listingId: listing.id,
    });

    res.status(201).json({
      success: true,
      data: listing,
    });
  } catch (error) {
    logger.error("[Listings] Error creating listing", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      body: req.body,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
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

    // Validate required field
    if (!s3Key) {
      res.status(400).json({
        success: false,
        error: "s3Key is required",
      });
      return;
    }

    // Get bucket name from environment variable
    const bucketName = process.env.AWS_BUCKET || "reelty-prod-storage";
    const region = process.env.AWS_REGION || "us-east-2";

    // Construct the full S3 URL with proper bucket name and region
    const s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${s3Key}`;

    logger.info("[LISTINGS] Processing photo upload:", {
      listingId,
      userId,
      s3Key,
      order,
    });

    logger.info("[Listings] Uploading photo", {
      listingId,
      userId,
      order,
    });

    // Check if listing exists and belongs to user
    const listing = await prisma.listing.findUnique({
      where: {
        id: listingId,
        userId, // Ensure listing belongs to authenticated user
      },
      include: {
        photos: true,
      },
    });

    if (!listing) {
      logger.error("[Listings] Listing not found or access denied", {
        listingId,
        userId,
      });
      res.status(404).json({
        success: false,
        error: "Listing not found or access denied",
      });
      return;
    }

    // Note: File type validation is now done in the frontend before S3 upload

    // Create photo record with the backend-constructed S3 URL
    const photo = await prisma.photo.create({
      data: {
        userId,
        listingId,
        filePath: s3Url, // Store the full URL for Runway access
        s3Key, // Store S3 key for internal operations
        order,
        status: "completed", // Image is already processed and uploaded
      },
    });

    logger.info("[Listings] Photo record created", {
      photoId: photo.id,
      listingId,
      url: s3Url,
      s3Key,
      order,
    });

    logger.info("[Listings] Photo record created", {
      photoId: photo.id,
      listingId,
      s3Key,
      filePath: s3Url,
    });

    // Check if we should start video generation
    const updatedListing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: { photos: true },
    });

    if (!updatedListing) {
      logger.error("[Listings] Failed to fetch updated listing", {
        listingId,
        userId,
      });
      throw new Error("Failed to fetch updated listing");
    }

    // Only start video generation if we have photos
    if (updatedListing.photos.length > 0) {
      logger.info("[Listings] Starting video generation process", {
        listingId,
        photoCount: updatedListing.photos.length,
        photoUrls: updatedListing.photos.map((p) => p.filePath),
      });

      // Create a new video generation job
      const job = await prisma.videoJob.create({
        data: {
          listingId,
          userId,
          status: "PROCESSING",
        },
      });

      logger.info("[Listings] Created video generation job", {
        jobId: job.id,
        listingId,
        photoCount: updatedListing.photos.length,
      });

      // Start the production pipeline
      const photoUrls = updatedListing.photos.map((p) => p.filePath);

      // Parse coordinates if they exist
      const coordinates =
        updatedListing.coordinates &&
        typeof updatedListing.coordinates === "object"
          ? {
              lat: Number((updatedListing.coordinates as any).lat),
              lng: Number((updatedListing.coordinates as any).lng),
            }
          : undefined;

      logger.info("[Listings] Starting production pipeline", {
        jobId: job.id,
        listingId,
        hasCoordinates: !!coordinates,
        photoCount: photoUrls.length,
      });

      // Start the pipeline in the background
      productionPipeline
        .execute({
          jobId: job.id,
          inputFiles: photoUrls,
          template: "googlezoomintro",
          coordinates,
        })
        .catch((error: unknown) => {
          logger.error("[Listings] Error starting production pipeline", {
            error: error instanceof Error ? error.message : "Unknown error",
            jobId: job.id,
            listingId,
          });
        });
    }

    res.status(201).json({
      success: true,
      data: photo,
    });
  } catch (error) {
    logger.error("[Listings] Error uploading photo", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Delete listing by ID
const deleteListing = async (req: Request, res: Response): Promise<void> => {
  try {
    const { listingId } = req.params;
    const userId = req.user!.id;

    // Check if listing exists and belongs to user
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        photos: true,
        videoJobs: true,
      },
    });

    if (!listing) {
      res.status(404).json({
        success: false,
        error: "Listing not found",
      });
      return;
    }

    if (listing.userId !== userId) {
      res.status(403).json({
        success: false,
        error: "Access denied",
      });
      return;
    }

    // Delete all associated data in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete video jobs first
      await tx.videoJob.deleteMany({
        where: { listingId },
      });

      // Delete photos from S3 and database
      for (const photo of listing.photos) {
        // Delete from S3
        if (photo.filePath) {
          await storageService.deleteFile(photo.filePath);
        }
        if (photo.processedFilePath) {
          await storageService.deleteFile(photo.processedFilePath);
        }
      }

      // Delete all photos from database
      await tx.photo.deleteMany({
        where: { listingId },
      });

      // Finally delete the listing
      await tx.listing.delete({
        where: { id: listingId },
      });
    });

    logger.info("[Listings] Listing deleted", {
      listingId,
      userId,
    });

    res.status(204).send();
  } catch (error) {
    logger.error("[Listings] Error deleting listing", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Batch process photos for a listing
router.post(
  "/:listingId/process-photos",
  isAuthenticated,
  async (req: Request, res: Response) => {
    const { listingId } = req.params;
    const { photos } = req.body;
    const userId = req.user!.id;

    try {
      // Process each photo
      for (const photo of photos) {
        const { id, s3Key: tempKey } = photo;

        // Move from temp to permanent storage
        const permanentKey = `properties/${listingId}/images/${id}-${path.basename(
          tempKey
        )}`;

        await s3VideoService.moveFromTempToListing(
          tempKey,
          permanentKey,
          process.env.AWS_BUCKET || "reelty-prod-storage"
        );

        // Update photo record
        await prisma.photo.create({
          data: {
            id,
            userId,
            listingId,
            s3Key: permanentKey,
            filePath: s3VideoService.getPublicUrl(permanentKey),
            status: "completed",
          },
        });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error("Failed to process photos:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Add this new endpoint to get photo processing status
router.get(
  "/:listingId/photos/status",
  isAuthenticated,
  async (req: Request, res: Response): Promise<void> => {
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

      // Transform photos to include correct URLs
      const transformedPhotos = photos.map((photo) => {
        // Construct the full S3 URL with proper bucket name
        const s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${photo.s3Key}`;

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
      logger.error("[PHOTOS_STATUS_ERROR]", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        success: false,
        error: "Failed to fetch photo status",
      });
    }
  }
);

// Add this new endpoint to get latest videos
router.get(
  "/:listingId/latest-videos",
  isAuthenticated,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { listingId } = req.params;
      const userId = req.user!.id;

      // Validate listingId
      if (!listingId || listingId === "undefined") {
        logger.error("[LATEST_VIDEOS_ERROR] Invalid listingId", {
          listingId,
          userId,
        });
        res.status(400).json({
          success: false,
          error: "Invalid listing ID",
        });
        return;
      }

      logger.info("[LATEST_VIDEOS] Fetching videos", {
        listingId,
        userId,
      });

      const videos = await prisma.videoJob.findMany({
        where: {
          listingId,
          userId,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          id: true,
          status: true,
          outputFile: true,
          thumbnailUrl: true,
          createdAt: true,
          metadata: true,
        },
      });

      // Calculate processing status
      const processingCount = videos.filter(
        (v) => v.status === "PROCESSING" || v.status === "QUEUED"
      ).length;
      const failedCount = videos.filter((v) => v.status === "FAILED").length;
      const completedCount = videos.filter(
        (v) => v.status === "COMPLETED"
      ).length;

      // Determine if polling should end (no processing jobs and at least one video)
      const shouldEndPolling = processingCount === 0 && videos.length > 0;

      logger.info("[LATEST_VIDEOS] Found videos", {
        listingId,
        count: videos.length,
        processing: processingCount,
        failed: failedCount,
        completed: completedCount,
        shouldEndPolling,
      });

      res.json({
        success: true,
        videos,
        status: {
          isProcessing: processingCount > 0,
          processingCount,
          failedCount,
          completedCount,
          totalCount: videos.length,
          shouldEndPolling,
        },
      });
    } catch (error) {
      logger.error("[LATEST_VIDEOS_ERROR]", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        success: false,
        error: "Failed to fetch latest videos",
      });
    }
  }
);

// Route handlers
router.get("/", isAuthenticated, getListings);
router.get("/:listingId", isAuthenticated, getListing);
router.post(
  "/",
  isAuthenticated,
  validateRequest(createListingSchema),
  createListing
);
router.post("/:listingId/photos", isAuthenticated, uploadPhoto);
router.delete("/:listingId", isAuthenticated, deleteListing);

export default router;
