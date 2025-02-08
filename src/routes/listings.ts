import express, { RequestHandler } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { getAuth } from "@clerk/express";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const createListingSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    address: z.string().min(1),
    description: z.string().optional(),
    coordinates: z
      .object({
        lat: z.number(),
        lng: z.number(),
      })
      .optional(),
    photoLimit: z.number().optional(),
  }),
});

// Get all listings for the authenticated user
const getListings: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const listings = await prisma.listing.findMany({
      where: {
        userId: auth.userId,
      },
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

    res.json({
      success: true,
      data: listings,
    });
  } catch (error) {
    console.error("Get listings error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Create new listing
const createListing: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { address, description, coordinates, photoLimit } = req.body;

    const listingData: Prisma.ListingUncheckedCreateInput = {
      address,
      description,
      userId: auth.userId,
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

    res.status(201).json({
      success: true,
      data: listing,
    });
  } catch (error) {
    console.error("Create listing error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.get("/", getListings);
router.post("/", validateRequest(createListingSchema), createListing);

export default router;
