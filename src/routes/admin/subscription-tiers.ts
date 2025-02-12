import { PrismaClient } from "@prisma/client";
import express from "express";
import { isAdmin as requireAdmin } from "../../middleware/auth";

const router = express.Router();
const prisma = new PrismaClient();

// Get all subscription tiers
async function getSubscriptionTiers(
  req: express.Request,
  res: express.Response
) {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const tiers = await prisma.subscriptionTier.findMany({
      take: Number(limit),
      skip,
      orderBy: {
        monthlyPrice: 'asc'
      }
    });

    const total = await prisma.subscriptionTier.count();

    res.json({
      success: true,
      data: tiers,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error("Error fetching subscription tiers:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch subscription tiers"
    });
  }
}

// Apply admin middleware to all routes
router.use(requireAdmin);

// Register routes
router.get("/", getSubscriptionTiers);

export default router;
