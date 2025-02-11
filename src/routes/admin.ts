import { getAuth } from "@clerk/express";
import { PrismaClient } from "@prisma/client";
import { format, subDays } from "date-fns";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { SUBSCRIPTION_TIERS } from "../constants/subscription-tiers";
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

const assetUpdateSchema = z.object({
  body: assetSchema.shape.body.partial(),
});

const creditAdjustmentSchema = z.object({
  body: z.object({
    amount: z.number(),
    reason: z.string().min(1),
  }),
});

const statusUpdateSchema = z.object({
  body: z.object({
    status: z.enum([
      "active",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "trialing",
      "unpaid",
      "inactive",
    ]),
  }),
});

// Middleware to check if user is admin
const requireAdmin: RequestHandler = async (req, res, next) => {
  try {
    console.log("[ADMIN_CHECK] Request path:", req.path);
    console.log("[ADMIN_CHECK] Request headers:", {
      authorization: req.headers.authorization ? "present" : "missing",
    });

    const auth = getAuth(req);
    const { userId, sessionId } = auth;

    console.log("[ADMIN_CHECK] Auth info:", { userId, sessionId });

    if (!userId || !sessionId) {
      console.log("[ADMIN_CHECK] No userId or sessionId");
      res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid session",
        status: 401,
      });
      return;
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        currentTierId: true,
      },
    });

    console.log("[ADMIN_CHECK] User data:", {
      found: !!user,
      currentTierId: user?.currentTierId,
    });

    if (!user) {
      console.log("[ADMIN_CHECK] User not found");
      res.status(401).json({
        success: false,
        error: "Unauthorized: User not found",
        status: 401,
      });
      return;
    }

    if (
      !user.currentTierId ||
      user.currentTierId !== SUBSCRIPTION_TIERS.ADMIN
    ) {
      console.log("[ADMIN_CHECK] Not admin tier:", {
        currentTierId: user.currentTierId,
        requiredTierId: SUBSCRIPTION_TIERS.ADMIN,
      });
      res.status(403).json({
        success: false,
        error: "Forbidden: Admin access required",
        status: 403,
      });
      return;
    }

    console.log("[ADMIN_CHECK] Admin access granted");
    // Add user info to request for downstream handlers
    req.user = { id: userId, role: "ADMIN" };
    next();
  } catch (error) {
    console.error("[ADMIN_CHECK_ERROR]", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: "Internal server error",
      status: 500,
    });
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
      if (job.status === "COMPLETED") acc[date].success++;
      if (job.status === "FAILED") acc[date].failed++;
      return acc;
    }, {});

    // Transform the data for the frontend
    const stats = {
      processingStats: {
        total: totalJobs,
        success:
          processingStats.find((s) => s.status === "COMPLETED")?._count ?? 0,
        failed: processingStats.find((s) => s.status === "FAILED")?._count ?? 0,
        inProgress:
          processingStats.find((s) => s.status === "PROCESSING")?._count ?? 0,
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
          subscriptionStats.find((s) => s.subscriptionStatus === "ACTIVE")
            ?._count || 0,
        cancelled:
          subscriptionStats.find((s) => s.subscriptionStatus === "CANCELED")
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

// User handlers
const listUsers: RequestHandler = async (req, res, next) => {
  try {
    const { tier, status, minCredits, maxCredits, search } = req.query;

    // Build where clause
    const where: any = {};

    if (tier) {
      where.currentTierId = tier as string;
    }

    if (status) {
      // Validate status against allowed values
      const validStatuses = [
        "active",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "past_due",
        "trialing",
        "unpaid",
        "inactive",
      ] as const;

      if (!validStatuses.includes(status as any)) {
        res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
        return next();
      }

      where.subscriptionStatus = status as string;
    }

    // Get users with their credit logs
    const users = await prisma.user.findMany({
      where,
      include: {
        currentTier: true,
        creditLogs: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Calculate credits for each user
    const usersWithCredits = await Promise.all(
      users.map(async (user) => {
        // Calculate total credits from credit logs
        const credits = user.creditLogs.reduce(
          (total, log) => total + log.amount,
          0
        );

        // Apply credits filter if specified
        if (
          (minCredits && credits < parseInt(minCredits as string)) ||
          (maxCredits && credits > parseInt(maxCredits as string))
        ) {
          return null;
        }

        // Apply search filter if specified
        if (search) {
          const searchLower = (search as string).toLowerCase();
          const fullName = `${user.firstName || ""} ${
            user.lastName || ""
          }`.toLowerCase();
          const email = user.email.toLowerCase();

          if (!fullName.includes(searchLower) && !email.includes(searchLower)) {
            return null;
          }
        }

        return {
          id: user.id,
          email: user.email,
          name:
            `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
            "Unknown",
          subscriptionTier: user.currentTierId,
          credits,
          status: user.subscriptionStatus || "INACTIVE",
          lastActive:
            user.lastLoginAt?.toISOString() || user.updatedAt.toISOString(),
          createdAt: user.createdAt.toISOString(),
        };
      })
    );

    // Filter out null values (users that didn't match filters)
    const transformedUsers = usersWithCredits.filter(
      (user): user is NonNullable<typeof user> => user !== null
    );

    res.json({
      success: true,
      data: transformedUsers,
    });
    return next();
  } catch (error) {
    console.error("[LIST_USERS_ERROR]", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
    return next();
  }
};

// Credit adjustment route
const adjustUserCredits: RequestHandler = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return next();
    }

    // Create credit log
    const creditLog = await prisma.creditLog.create({
      data: {
        userId,
        amount,
        reason,
        adminId: req.user!.id, // Admin who made the adjustment
      },
      include: {
        user: {
          select: {
            email: true,
          },
        },
      },
    });

    // Calculate new total credits
    const totalCredits = await prisma.creditLog.aggregate({
      where: {
        userId,
      },
      _sum: {
        amount: true,
      },
    });

    res.json({
      success: true,
      data: {
        creditLog,
        totalCredits: totalCredits._sum.amount || 0,
      },
    });
    return next();
  } catch (error) {
    console.error("[CREDIT_ADJUST]", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
    return next();
  }
};

// Update user status
const updateUserStatus: RequestHandler = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return next();
    }

    // Update user status
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: status,
        updatedAt: new Date(),
      },
    });

    res.json({
      success: true,
      data: updatedUser,
    });
  } catch (error) {
    console.error("[UPDATE_USER_STATUS]", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
    return next();
  }
};

// Route handlers
router.get("/users", listUsers);
router.post(
  "/users/:userId/credits",
  validateRequest(creditAdjustmentSchema),
  adjustUserCredits
);
router.post(
  "/users/:userId/status",
  validateRequest(statusUpdateSchema),
  updateUserStatus
);
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
