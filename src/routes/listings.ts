import express, { Request, Response } from "express";
import { PrismaClient, Prisma, VideoGenerationStatus } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { logger } from "../utils/logger";
import { StorageService } from "../services/storage";
import multer from "multer";
import { isAuthenticated } from "../middleware/auth";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";

const router = express.Router();
const prisma = new PrismaClient();
const storageService = StorageService.getInstance();
const upload = multer();

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
    console.log("[LISTINGS] Starting photo upload:", {
      hasFile: !!req.file,
      contentType: req.file?.mimetype,
      listingId: req.params.listingId,
      awsBucket: process.env.AWS_BUCKET,
      awsRegion: process.env.AWS_REGION,
    });

    const { listingId } = req.params;
    const userId = req.user!.id;
    const file = req.file;
    const order = parseInt(req.body.order || "0", 10);

    if (!file) {
      res.status(400).json({
        success: false,
        error: "No file provided",
      });
      return;
    }

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

    const validMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;

    if (!validMimeTypes.includes(file.mimetype as any)) {
      res.status(400).json({
        success: false,
        error: "Invalid file type. Only JPEG, PNG and WebP are allowed.",
      });
      return;
    }

    // Upload file to S3 using StorageService
    const uploadResult = await storageService.uploadPropertyMedia(listingId, {
      name: file.originalname,
      type: "image",
      contentType: file.mimetype as (typeof validMimeTypes)[number],
      buffer: file.buffer,
    });

    // Create photo record with the S3 URL
    const photo = await prisma.photo.create({
      data: {
        userId,
        listingId,
        filePath: uploadResult.uploadUrl,
        order,
      },
    });

    logger.info("[Listings] Photo uploaded successfully", {
      photoId: photo.id,
      listingId,
      url: uploadResult.uploadUrl,
    });

    // Check if this is the last photo and trigger video generation
    const updatedListing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: { photos: true },
    });

    if (updatedListing && updatedListing.photos.length > 0) {
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
      const productionPipeline = new ProductionPipeline();
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
          template: "default",
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

// Route handlers
router.get("/", isAuthenticated, getListings);
router.get("/:listingId", isAuthenticated, getListing);
router.post(
  "/",
  isAuthenticated,
  validateRequest(createListingSchema),
  createListing
);
router.post(
  "/:listingId/photos",
  isAuthenticated,
  upload.single("file"), // Handle single file upload
  uploadPhoto
);
router.delete("/:listingId", isAuthenticated, deleteListing);

export default router;
