import express, { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { SUBSCRIPTION_TIERS } from "../constants/subscription-tiers";
import { subDays, startOfDay, endOfDay, format } from "date-fns";

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
      select: {
        currentTierId: true,
      },
    });

    if (
      !user?.currentTierId ||
      user.currentTierId !== SUBSCRIPTION_TIERS.ADMIN
    ) {
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
        by: ["currentTierId"],
        _count: true,
      }),
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        usersByTier: usersByTier.map((tier) => ({
          tier: tier.currentTierId,
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

// Analytics handlers
const getVideoAnalytics: RequestHandler = async (_req, res) => {
  try {
    const [totalJobs, processingStats] = await Promise.all([
      // Total number of jobs
      prisma.videoJob.count(),

      // Processing status distribution
      prisma.videoJob.groupBy({
        by: ["status"],
        _count: true,
      }),
    ]);

    // Get jobs for the last 30 days
    const thirtyDaysAgo = subDays(new Date(), 30);
    const dailyJobs = await prisma.videoJob.findMany({
      where: {
        createdAt: {
          gte: thirtyDaysAgo,
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Get jobs for time distribution (last 7 days)
    const sevenDaysAgo = subDays(new Date(), 7);
    const recentJobs = await prisma.videoJob.findMany({
      where: {
        createdAt: {
          gte: sevenDaysAgo,
        },
      },
      select: {
        createdAt: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Calculate time distribution
    const timeDistribution = recentJobs.reduce(
      (acc: Record<number, number>, job) => {
        const hour = job.createdAt.getHours();
        acc[hour] = (acc[hour] || 0) + 1;
        return acc;
      },
      {}
    );

    // Group daily jobs
    const dailyJobStats = dailyJobs.reduce((acc: Record<string, any>, job) => {
      const date = format(job.createdAt, "MMM dd");
      if (!acc[date]) {
        acc[date] = { total: 0, success: 0, failed: 0 };
      }
      acc[date].total++;
      if (job.status === "success") acc[date].success++;
      if (job.status === "failed") acc[date].failed++;
      return acc;
    }, {});

    // Transform the data for the frontend
    const stats = {
      processingStats: {
        total: totalJobs,
        success:
          processingStats.find((s) => s.status === "success")?._count ?? 0,
        failed: processingStats.find((s) => s.status === "failed")?._count ?? 0,
        inProgress:
          processingStats.find((s) => s.status === "processing")?._count ?? 0,
      },
      dailyJobs: Object.entries(dailyJobStats).map(([date, stats]) => ({
        date,
        ...stats,
      })),
      timeDistribution: Object.entries(timeDistribution).map(
        ([hour, count]) => ({
          hour: parseInt(hour),
          count,
        })
      ),
    };

    res.json(stats);
  } catch (error) {
    console.error("[VIDEO_ANALYTICS]", error);
    res.status(500).json({ error: "Failed to fetch video analytics" });
  }
};

const getRevenueAnalytics: RequestHandler = async (_req, res) => {
  try {
    const thirtyDaysAgo = subDays(new Date(), 30);

    const [subscriptionStats, subscriptionLogs] = await Promise.all([
      // Subscription statistics
      prisma.user.groupBy({
        by: ["subscriptionStatus"],
        _count: true,
      }),

      // Get all subscription logs with tier info
      prisma.subscriptionLog.findMany({
        where: {
          createdAt: {
            gte: thirtyDaysAgo,
          },
        },
        include: {
          user: {
            select: {
              currentTier: true,
            },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      }),
    ]);

    // Calculate revenue metrics using tier prices
    const totalRevenue = subscriptionLogs.reduce((sum, log) => {
      const monthlyPrice = log.user.currentTier?.monthlyPrice || 0;
      return sum + monthlyPrice;
    }, 0);

    // Group by month
    const monthlyRevenue = subscriptionLogs.reduce(
      (acc: Record<string, number>, log) => {
        const month = format(log.createdAt, "MMM yyyy");
        const monthlyPrice = log.user.currentTier?.monthlyPrice || 0;
        acc[month] = (acc[month] || 0) + monthlyPrice;
        return acc;
      },
      {}
    );

    // Group by tier
    const revenueByTier = subscriptionLogs.reduce(
      (acc: Record<string, number>, log) => {
        const tierId = log.user.currentTier?.id || "unknown";
        const monthlyPrice = log.user.currentTier?.monthlyPrice || 0;
        acc[tierId] = (acc[tierId] || 0) + monthlyPrice;
        return acc;
      },
      {}
    );

    // Group by day
    const dailyRevenue = subscriptionLogs.reduce(
      (acc: Record<string, number>, log) => {
        const date = format(log.createdAt, "MMM dd");
        const monthlyPrice = log.user.currentTier?.monthlyPrice || 0;
        acc[date] = (acc[date] || 0) + monthlyPrice;
        return acc;
      },
      {}
    );

    const stats = {
      totalRevenue,
      monthlyRevenue: Object.entries(monthlyRevenue).map(([month, amount]) => ({
        month,
        amount,
      })),
      subscriptionStats: {
        active:
          subscriptionStats.find((s) => s.subscriptionStatus === "active")
            ?._count || 0,
        cancelled:
          subscriptionStats.find((s) => s.subscriptionStatus === "cancelled")
            ?._count || 0,
        total: subscriptionStats.reduce((acc, curr) => acc + curr._count, 0),
      },
      revenueByTier: Object.entries(revenueByTier).map(([tier, amount]) => ({
        tier,
        amount,
      })),
      dailyRevenue: Object.entries(dailyRevenue).map(([date, amount]) => ({
        date,
        amount,
      })),
    };

    res.json(stats);
  } catch (error) {
    console.error("[REVENUE_ANALYTICS]", error);
    res.status(500).json({ error: "Failed to fetch revenue analytics" });
  }
};

const getCreditAnalytics: RequestHandler = async (_req, res) => {
  try {
    const thirtyDaysAgo = subDays(new Date(), 30);

    const [creditLogs, topUserCredits] = await Promise.all([
      // Get all credit logs
      prisma.creditLog.findMany({
        where: {
          createdAt: {
            gte: thirtyDaysAgo,
          },
        },
        include: {
          user: {
            select: {
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      }),

      // Get top users by credit usage
      prisma.creditLog.groupBy({
        by: ["userId"],
        _sum: {
          amount: true,
        },
        orderBy: {
          _sum: {
            amount: "desc",
          },
        },
        take: 10,
      }),
    ]);

    // Calculate total credits
    const totalCredits = creditLogs.reduce((sum, log) => sum + log.amount, 0);

    // Group by type
    const creditsByType = creditLogs.reduce(
      (acc: Record<string, number>, log) => {
        acc[log.reason] = (acc[log.reason] || 0) + log.amount;
        return acc;
      },
      {}
    );

    // Group by day
    const dailyCredits = creditLogs.reduce(
      (acc: Record<string, number>, log) => {
        const date = format(log.createdAt, "MMM dd");
        acc[date] = (acc[date] || 0) + log.amount;
        return acc;
      },
      {}
    );

    const stats = {
      totalCredits,
      creditsByType: Object.entries(creditsByType).map(([reason, amount]) => ({
        reason,
        amount,
      })),
      topUsers: await Promise.all(
        topUserCredits.map(async (usage) => {
          const user = await prisma.user.findUnique({
            where: { id: usage.userId },
            select: { email: true },
          });
          return {
            userId: usage.userId,
            email: user?.email || "Unknown",
            credits: usage._sum?.amount || 0,
          };
        })
      ),
      dailyCredits: Object.entries(dailyCredits).map(([date, amount]) => ({
        date,
        amount,
      })),
    };

    res.json(stats);
  } catch (error) {
    console.error("[CREDIT_ANALYTICS]", error);
    res.status(500).json({ error: "Failed to fetch credit analytics" });
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

// Analytics routes
router.get("/analytics/videos", getVideoAnalytics);
router.get("/analytics/revenue", getRevenueAnalytics);
router.get("/analytics/credits", getCreditAnalytics);

export default router;
