import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import express from "express";
import { isAdmin as requireAdmin } from "../../middleware/auth.js";

const router = express.Router();
const prisma = new PrismaClient();

// User stats handler
async function getUserStats(_req: express.Request, res: express.Response) {
  try {
    // Get all users
    const users = await prisma.user.findMany({
      include: {
        subscriptionLogs: true,
        subscriptions: {
          where: {
            status: {
              not: SubscriptionStatus.INACTIVE,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
          include: {
            tier: true,
          },
        },
      },
    });

    // Calculate total users
    const totalUsers = users.length;

    // Calculate active users (users with active subscription)
    const activeUsers = users.filter(
      (user) => user.subscriptions[0]?.status === SubscriptionStatus.ACTIVE
    ).length;

    // Calculate users by tier
    const usersByTier = users.reduce((acc: any[], user) => {
      const activeTier = user.subscriptions[0]?.tier;
      if (!activeTier) return acc;

      const existing = acc.find((t) => t.tier === activeTier.name);
      if (existing) {
        existing.count++;
      } else {
        acc.push({
          tier: activeTier.name,
          count: 1,
        });
      }
      return acc;
    }, []);

    // Calculate users by status
    const usersByStatus = users.reduce((acc: any[], user) => {
      const status = user.subscriptions[0]?.status || "NO_SUBSCRIPTION";
      const existing = acc.find((s) => s.status === status);
      if (existing) {
        existing.count++;
      } else {
        acc.push({
          status,
          count: 1,
        });
      }
      return acc;
    }, []);

    // Calculate new users in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const newUsers = users.filter(
      (user) => user.createdAt >= thirtyDaysAgo
    ).length;

    // Return stats
    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        newUsers,
        usersByTier,
        usersByStatus,
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
