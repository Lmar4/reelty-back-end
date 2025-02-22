import { PrismaClient } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isAdmin } from "../../middleware/auth";
import { validateRequest } from "../../middleware/validate";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const assetSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    filePath: z.string().min(1),
    type: z.enum(["MUSIC", "WATERMARK", "LOTTIE"]),
    subscriptionTier: z.string().min(1),
    isActive: z.boolean().optional(),
  }),
});

const assetUpdateSchema = z.object({
  body: assetSchema.shape.body.partial(),
});

// Apply admin middleware to all routes
router.use(isAdmin);

// Asset handlers
const getAssets: RequestHandler = async (_req, res) => {
  try {
    const assets = await prisma.asset.findMany({
      include: {
        subscriptionTier: true,
      },
    });

    res.json({
      success: true,
      data: assets,
    });
  } catch (error) {
    console.error("Get assets error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

const createAsset: RequestHandler = async (req, res) => {
  try {
    const asset = await prisma.asset.create({
      data: req.body,
      include: {
        subscriptionTier: true,
      },
    });

    res.status(201).json({
      success: true,
      data: asset,
    });
  } catch (error) {
    console.error("Create asset error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

const updateAsset: RequestHandler = async (req, res) => {
  try {
    const { assetId } = req.params;
    const asset = await prisma.asset.update({
      where: { id: assetId },
      data: req.body,
      include: {
        subscriptionTier: true,
      },
    });

    res.json({
      success: true,
      data: asset,
    });
  } catch (error) {
    console.error("Update asset error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Record to update not found")
    ) {
      res.status(404).json({
        success: false,
        error: "Asset not found",
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

const deleteAsset: RequestHandler = async (req, res) => {
  try {
    const { assetId } = req.params;
    await prisma.asset.delete({
      where: { id: assetId },
    });

    res.json({
      success: true,
      message: "Asset deleted successfully",
    });
  } catch (error) {
    console.error("Delete asset error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Record to delete does not exist")
    ) {
      res.status(404).json({
        success: false,
        error: "Asset not found",
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Register routes
router.get("/assets", getAssets);
router.post("/assets", validateRequest(assetSchema), createAsset);
router.patch(
  "/assets/:assetId",
  validateRequest(assetUpdateSchema),
  updateAsset
);
router.delete("/assets/:assetId", deleteAsset);

export default router;
