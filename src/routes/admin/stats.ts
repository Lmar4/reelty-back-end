import { PrismaClient } from "@prisma/client";
import express from "express";
import { isAdmin as requireAdmin } from "../../middleware/auth";

const router = express.Router();
const prisma = new PrismaClient();

// User stats handler
async function getUserStats(_req: express.Request, res: express.Response) {
  try {
    // Get all users
    const users = await prisma.user.findMany({
      include: {
        subscriptionLogs: true,
        currentTier: true,
      },
    });

    // Calculate total users
    const totalUsers = users.length;

    // Calculate active users (users with active subscription)
    const activeUsers = users.filter(
      (user) => user.subscriptionStatus === "ACTIVE"
    ).length;

    // Calculate users by tier
    const usersByTier = users.reduce((acc: any[], user) => {
      if (!user.currentTier) return acc;

      const existing = acc.find((t) => t.tier === user.currentTier?.name);
      if (existing) {
        existing.count++;
      } else {
        acc.push({
          tier: user.currentTier.name,
          count: 1,
        });
      }

      return acc;
    }, []);

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        usersByTier,
      },
    });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch user stats",
    });
  }
}

// Apply admin middleware to all routes
router.use(requireAdmin);

// Register routes
router.get("/users", getUserStats);

export default router;
