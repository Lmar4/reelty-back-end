import {
  PrismaClient,
  VideoGenerationStatus,
  SubscriptionStatus,
} from "@prisma/client";
import express from "express";
import { format, subDays } from "date-fns";
import { isAdmin as requireAdmin } from "../../middleware/auth.js";

const router = express.Router();
const prisma = new PrismaClient();

// Video analytics handler
async function getVideoAnalytics(_req: express.Request, res: express.Response) {
  try {
    const jobs = await prisma.videoJob.findMany({
      where: {
        createdAt: {
          gte: subDays(new Date(), 30),
        },
      },
    });

    const processingStats = {
      total: jobs.length,
      success: jobs.filter(
        (job) => job.status === VideoGenerationStatus.COMPLETED
      ).length,
      failed: jobs.filter((job) => job.status === VideoGenerationStatus.FAILED)
        .length,
      inProgress: jobs.filter(
        (job) => job.status === VideoGenerationStatus.PROCESSING
      ).length,
    };

    // Calculate daily jobs
    const dailyJobs = jobs.reduce((acc: any[], job) => {
      const date = format(job.createdAt, "yyyy-MM-dd");
      const existing = acc.find((d) => d.date === date);

      if (existing) {
        existing.total++;
        if (job.status === VideoGenerationStatus.COMPLETED) existing.success++;
        if (job.status === VideoGenerationStatus.FAILED) existing.failed++;
      } else {
        acc.push({
          date,
          total: 1,
          success: job.status === VideoGenerationStatus.COMPLETED ? 1 : 0,
          failed: job.status === VideoGenerationStatus.FAILED ? 1 : 0,
        });
      }

      return acc;
    }, []);

    // Calculate time distribution
    const timeDistribution = jobs.reduce((acc: any[], job) => {
      const hour = job.createdAt.getHours();
      const existing = acc.find((d) => d.hour === hour);

      if (existing) {
        existing.count++;
      } else {
        acc.push({ hour, count: 1 });
      }

      return acc;
    }, []);

    res.json({
      success: true,
      data: {
        processingStats,
        dailyJobs,
        timeDistribution,
      },
    });
  } catch (error) {
    console.error("Error fetching video analytics:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch video analytics",
    });
  }
}

// Revenue analytics handler
async function getRevenueAnalytics(
  _req: express.Request,
  res: express.Response
) {
  try {
    const users = await prisma.user.findMany({
      include: {
        activeSubscription: {
          include: {
            tier: true,
          },
        },
      },
    });

    // Filter users with active subscriptions
    const activeUsers = users.filter(
      (user) =>
        user.activeSubscription && user.activeSubscription.status === "ACTIVE"
    );

    const totalRevenue = activeUsers.reduce(
      (sum: number, user) =>
        sum + (user.activeSubscription?.tier?.monthlyPriceCents || 0) / 100,
      0
    );

    const subscriptionStats = {
      active: activeUsers.length,
      cancelled: users.filter(
        (user) => user.activeSubscription?.status === "CANCELED"
      ).length,
      total: users.length,
    };

    const revenueByTier = activeUsers.reduce(
      (acc: Array<{ tier: string; count: number; revenue: number }>, user) => {
        if (!user.activeSubscription?.tier) return acc;

        const existing = acc.find(
          (t) => t.tier === user.activeSubscription?.tier?.name
        );
        if (existing) {
          existing.count++;
          existing.revenue +=
            user.activeSubscription.tier.monthlyPriceCents / 100;
        } else {
          acc.push({
            tier: user.activeSubscription.tier.name,
            count: 1,
            revenue: user.activeSubscription.tier.monthlyPriceCents / 100,
          });
        }
        return acc;
      },
      []
    );

    // Calculate revenue by date (last 30 days)
    const revenueByDate = activeUsers.reduce(
      (acc: Array<{ date: string; revenue: number }>, user) => {
        const date = new Date().toISOString().split("T")[0]; // Today's date
        const existing = acc.find((d) => d.date === date);

        if (existing) {
          existing.revenue +=
            (user.activeSubscription?.tier?.monthlyPriceCents || 0) / 100;
        } else {
          acc.push({
            date,
            revenue:
              (user.activeSubscription?.tier?.monthlyPriceCents || 0) / 100,
          });
        }
        return acc;
      },
      []
    );

    res.json({
      success: true,
      data: {
        totalRevenue,
        subscriptionStats,
        revenueByTier,
        revenueByDate,
      },
    });
  } catch (error) {
    console.error("Error fetching revenue analytics:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch revenue analytics",
    });
  }
}

// Credit analytics handler
async function getCreditAnalytics(
  _req: express.Request,
  res: express.Response
) {
  try {
    const credits = await prisma.creditLog.findMany({
      include: {
        user: true,
      },
    });

    const totalCredits = credits.reduce(
      (sum: number, credit) => sum + credit.amount,
      0
    );

    interface CreditByType {
      type: string;
      count: number;
      total: number;
    }

    const creditsByType = credits.reduce((acc: CreditByType[], credit) => {
      const existing = acc.find((t) => t.type === credit.reason);
      if (existing) {
        existing.total += credit.amount;
        existing.count++;
      } else {
        acc.push({
          type: credit.reason,
          total: credit.amount,
          count: 1,
        });
      }
      return acc;
    }, []);

    interface UserCredit {
      [key: string]: {
        userId: string;
        email: string;
        total: number;
        count: number;
      };
    }

    const userCredits = credits.reduce((acc: UserCredit, credit) => {
      if (!acc[credit.userId]) {
        acc[credit.userId] = {
          userId: credit.userId,
          email: credit.user.email,
          total: 0,
          count: 0,
        };
      }
      acc[credit.userId].total += credit.amount;
      acc[credit.userId].count++;
      return acc;
    }, {});

    const topUsers = Object.values(userCredits)
      .sort((a: any, b: any) => b.total - a.total)
      .slice(0, 10);

    interface DailyCredit {
      date: string;
      total: number;
      count: number;
    }

    const dailyCredits = credits.reduce((acc: DailyCredit[], credit) => {
      const date = format(credit.createdAt, "yyyy-MM-dd");
      const existing = acc.find((d) => d.date === date);

      if (existing) {
        existing.total += credit.amount;
        existing.count++;
      } else {
        acc.push({
          date,
          total: credit.amount,
          count: 1,
        });
      }

      return acc;
    }, []);

    res.json({
      success: true,
      data: {
        totalCredits,
        creditsByType,
        topUsers,
        dailyCredits,
      },
    });
  } catch (error) {
    console.error("Error fetching credit analytics:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch credit analytics",
    });
  }
}

// Recent activity handler
async function getRecentActivity(_req: express.Request, res: express.Response) {
  try {
    // Get recent video processing activities
    const recentVideos = await prisma.videoJob.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { email: true },
        },
      },
    });

    // Get recent subscription changes
    const recentSubscriptions = await prisma.subscriptionLog.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { email: true },
        },
      },
    });

    // Get recent credit adjustments
    const recentCredits = await prisma.creditLog.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { email: true },
        },
      },
    });

    interface Activity {
      id: string;
      type: "video" | "subscription" | "credit";
      description: string;
      user: { email: string };
      createdAt: string;
    }

    // Combine and format all activities
    const activities: Activity[] = [
      ...recentVideos.map((v) => ({
        id: v.id,
        type: "video" as const,
        description: `Video ${v.status.toLowerCase()}`,
        user: { email: v.user.email },
        createdAt: v.createdAt.toISOString(),
      })),
      ...recentSubscriptions.map((s) => ({
        id: s.id,
        type: "subscription" as const,
        description: `Subscription ${s.status.toLowerCase()}`,
        user: { email: s.user.email },
        createdAt: s.createdAt.toISOString(),
      })),
      ...recentCredits.map((c) => ({
        id: c.id,
        type: "credit" as const,
        description: `Credits adjusted: ${c.amount} (${c.reason})`,
        user: { email: c.user.email },
        createdAt: c.createdAt.toISOString(),
      })),
    ];

    // Sort by most recent first
    activities.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Take most recent 20 activities
    const recentActivities = activities.slice(0, 20);

    res.json({
      success: true,
      data: recentActivities,
    });
  } catch (error) {
    console.error("Error fetching recent activities:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch recent activities",
    });
  }
}

// Apply admin middleware to all routes
router.use(requireAdmin);

// Register routes
router.get("/videos", getVideoAnalytics);
router.get("/revenue", getRevenueAnalytics);
router.get("/credits", getCreditAnalytics);
router.get("/activity", getRecentActivity);

export default router;
