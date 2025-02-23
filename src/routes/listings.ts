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
      currentTier: true,
      listings: {
        where: {
          status: "ACTIVE",
        },
      },
    },
  });

  if (!user || !user.currentTier) {
    throw new Error("User or subscription tier not found");
  }

  const currentCount = user.listings.length;
  const maxAllowed = user.currentTier.maxActiveListings;
  const currentTier = user.currentTier.name;

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
    const userId = req.user!.id;
    const { address, description, coordinates, photoLimit, photos } = req.body;

    // Check user's listing limit first
    const limitCheck = await checkUserListingLimit(userId);
    if (!limitCheck.canCreate) {
      logger.error("[Listings] User has reached listing limit", {
        userId,
        currentCount: limitCheck.currentCount,
        maxAllowed: limitCheck.maxAllowed,
        tier: limitCheck.currentTier,
      });
      res.status(403).json({
        success: false,
        error: "Listing limit reached",
        data: {
          currentCount: limitCheck.currentCount,
          maxAllowed: limitCheck.maxAllowed,
          currentTier: limitCheck.currentTier,
        },
      });
      return;
    }

    logger.info("[Listings] Creating new listing", {
      userId,
      address,
      hasCoordinates: !!coordinates,
      photoLimit,
      photoCount: photos?.length || 0,
    });

    // Validate photo limit
    const effectivePhotoLimit = photoLimit || 10;
    if (Array.isArray(photos) && photos.length > effectivePhotoLimit) {
      logger.error("[Listings] Photo limit exceeded", {
        limit: effectivePhotoLimit,
        received: photos.length,
      });
      res.status(400).json({
        success: false,
        error: `Photo limit exceeded: ${effectivePhotoLimit}`,
      });
      return;
    }

    // Validate coordinates more strictly
    if (coordinates) {
      if (
        !Number.isFinite(coordinates.lat) ||
        !Number.isFinite(coordinates.lng) ||
        coordinates.lat < -90 ||
        coordinates.lat > 90 ||
        coordinates.lng < -180 ||
        coordinates.lng > 180
      ) {
        logger.error("[Listings] Invalid coordinates format", { coordinates });
        res.status(400).json({
          success: false,
          error: "Invalid coordinates format or out of range",
        });
        return;
      }
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

        // Store listing ID for later use
        const listingId = listing.id;

        if (!validateUUID(listingId)) {
          throw new Error(`Invalid listing ID format: ${listingId}`);
        }

        logger.info("[Listings] Created listing", {
          listingId,
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
            if (!validateUUID(listing.id)) {
              throw new Error(
                `Invalid UUID format for listing ID: ${listing.id}`
              );
            }

            try {
              const photoRecord: PhotoRecord = await tx.photo.create({
                data: {
                  userId,
                  listingId,
                  s3Key,
                  filePath,
                  order: photoRecords.length,
                  status: "PENDING",
                },
              });
              photoRecords.push(photoRecord);

              logger.info(
                "[Listings] Photo record created with PENDING status",
                {
                  photoId: photoRecord.id,
                  listingId,
                  s3Key,
                  order: photoRecords.length,
                }
              );
            } catch (photoError) {
              logger.error("[Listings] Failed to create photo record", {
                error:
                  photoError instanceof Error
                    ? photoError.message
                    : "Unknown error",
                s3Key,
                listingId,
              });
              throw new Error(
                `Failed to create photo record for S3 key: ${s3Key}`
              );
            }
          }
        }

        // 3. Create video job if we have photos
        let videoJob = null;
        let inputFiles: string[] = [];
        if (photoRecords.length > 0) {
          inputFiles = photoRecords.map((photo) => photo.filePath);

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
              listingId,
              userId,
              status: VideoGenerationStatus.PENDING,
              template: "crescendo",
              inputFiles,
              position: 0,
              priority: 1,
            },
          });
        }

        return {
          listing,
          photos: photoRecords,
          jobId: videoJob?.id || null,
          inputFiles,
        };
      },
      {
        maxWait: 30000, // 30 seconds max wait
        timeout: 300000, // 5 minutes total timeout
      }
    );

    // Add immediate validation after transaction
    if (!result.listing?.id || !validateUUID(result.listing.id)) {
      logger.error("[Listings] Invalid listing ID after transaction", {
        listingId: result.listing?.id,
        timestamp: new Date().toISOString(),
      });
      throw new Error(
        `Invalid listing ID after transaction: ${result.listing?.id}`
      );
    }

    // Schedule pipeline execution after transaction ONLY if we have a video job
    if (result.jobId && result.inputFiles.length > 0) {
      const listingId = result.listing.id; // Guaranteed to be valid UUID at this point
      const jobId = result.jobId;
      const inputFiles = [...result.inputFiles];
      const coordinates = result.listing.coordinates;

      // Log pre-execution state
      logger.info("[Listings] Scheduling pipeline execution", {
        listingId,
        jobId,
        inputFilesCount: inputFiles.length,
        hasCoordinates: !!coordinates,
        timestamp: new Date().toISOString(),
      });

      // Store values in closure-safe variables
      const executionData = {
        listingId,
        jobId,
        inputFiles,
        coordinates,
      };

      // Increased delay to 1000ms for better stability
      setTimeout(async () => {
        try {
          // Double-check listing exists before executing pipeline
          const listingCheck = await prisma.listing.findUnique({
            where: { id: executionData.listingId },
            select: { id: true },
          });

          if (!listingCheck) {
            throw new Error(
              `Listing ${executionData.listingId} not found before pipeline execution`
            );
          }

          logger.info("[Listings] Starting pipeline execution", {
            jobId: executionData.jobId,
            listingId: executionData.listingId,
            inputFilesCount: executionData.inputFiles.length,
            timestamp: new Date().toISOString(),
          });

          await productionPipeline.execute({
            jobId: executionData.jobId,
            listingId: executionData.listingId,
            inputFiles: executionData.inputFiles,
            template: "crescendo",
            coordinates: executionData.coordinates as any,
            skipRunwayIfCached: true,
          });

          logger.info("[Listings] Pipeline execution initiated successfully", {
            jobId: executionData.jobId,
            listingId: executionData.listingId,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.error("[Listings] Pipeline execution failed", {
            error: error instanceof Error ? error.message : "Unknown error",
            jobId: executionData.jobId,
            listingId: executionData.listingId,
            timestamp: new Date().toISOString(),
            stack: error instanceof Error ? error.stack : undefined,
          });

          await prisma.videoJob.update({
            where: { id: executionData.jobId },
            data: {
              status: VideoGenerationStatus.FAILED,
              error: error instanceof Error ? error.message : "Unknown error",
              completedAt: new Date(),
              metadata: {
                errorDetails: {
                  message:
                    error instanceof Error ? error.message : "Unknown error",
                  stack: error instanceof Error ? error.stack : undefined,
                  timestamp: new Date().toISOString(),
                },
              } satisfies Prisma.InputJsonValue,
            },
          });
        }
      }, 1000);
    }

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
        const photoRecord = await prisma.photo.create({
          data: {
            id,
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
