import express, { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";

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

const assetUpdateSchema = assetSchema.deepPartial();

// Middleware to check if user is admin
const requireAdmin: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        error: "Unauthorized",
        status: 401,
      });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      include: {
        tier: true,
      },
    });

    if (!user?.tier?.isAdmin) {
      res.status(403).json({
        error: "Forbidden: Admin access required",
        status: 403,
      });
      return;
    }

    next();
  } catch (error) {
    console.error("Admin check error:", error);
    res.status(500).json({
      error: "Internal server error",
      status: 500,
    });
    return;
  }
};

// Apply admin check to all routes
router.use(requireAdmin);

// Asset handlers
const getAssets: RequestHandler = async (_req, res) => {
  try {
    const assets = await prisma.asset.findMany({
      include: {
        tier: true,
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
        tier: true,
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
        tier: true,
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

// User stats handler
const getUserStats: RequestHandler = async (_req, res) => {
  try {
    const [totalUsers, activeUsers, usersByTier] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: {
          lastLoginAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Active in last 30 days
          },
        },
      }),
      prisma.user.groupBy({
        by: ["subscriptionTier"],
        _count: true,
      }),
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        usersByTier: usersByTier.map((tier) => ({
          tier: tier.subscriptionTier,
          count: tier._count,
        })),
      },
    });
  } catch (error) {
    console.error("Get user stats error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.get("/assets", getAssets);
router.post("/assets", validateRequest(assetSchema), createAsset);
router.patch(
  "/assets/:assetId",
  validateRequest(assetUpdateSchema),
  updateAsset
);
router.delete("/assets/:assetId", deleteAsset);
router.get("/stats/users", getUserStats);

export default router;
