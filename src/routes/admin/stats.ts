import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import express from "express";
import { isAdmin as requireAdmin } from "../../middleware/auth.js";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";

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

// Business KPIs handler
async function getBusinessKpis(_req: express.Request, res: express.Response) {
  try {
    // Get current date and start of current month
    const now = new Date();
    const currentMonthStart = startOfMonth(now);
    const currentMonthEnd = endOfMonth(now);

    // Get start of previous month
    const previousMonthStart = startOfMonth(subMonths(now, 1));
    const previousMonthEnd = endOfMonth(subMonths(now, 1));

    // 1. Current Customers (users with active subscriptions)
    const currentCustomers = await prisma.user.count({
      where: {
        activeSubscriptionId: { not: null },
        deletedAt: null,
        activeSubscription: {
          status: "ACTIVE",
        },
      },
    });

    // 2. New Customers Per Month (users who started their first subscription this month)
    const newCustomersPerMonth = await prisma.subscriptionHistory.count({
      where: {
        startDate: {
          gte: currentMonthStart,
          lte: currentMonthEnd,
        },
        // Only count new subscriptions, not renewals
        user: {
          subscriptionHistory: {
            none: {
              startDate: {
                lt: currentMonthStart,
              },
            },
          },
        },
      },
    });

    // 3. Monthly Churn Rate
    // First, get customers at start of month
    const customersAtStartOfMonth = await prisma.user.count({
      where: {
        activeSubscriptionId: { not: null },
        deletedAt: null,
        activeSubscription: {
          startDate: { lt: currentMonthStart },
        },
      },
    });

    // Then, get churned customers during month
    const churnedCustomers = await prisma.subscriptionHistory.count({
      where: {
        status: { in: ["CANCELED", "INACTIVE"] },
        endDate: {
          gte: currentMonthStart,
          lte: currentMonthEnd,
        },
      },
    });

    // Calculate churn rate (handle division by zero)
    const monthlyChurnRate =
      customersAtStartOfMonth > 0
        ? (churnedCustomers / customersAtStartOfMonth) * 100
        : 0;

    // 4. Monthly ARPA (Average Revenue Per Account)
    // Get total revenue for the month
    const monthlyRevenue = await prisma.billingRecord.aggregate({
      _sum: {
        amountCents: true,
      },
      where: {
        billingDate: {
          gte: currentMonthStart,
          lte: currentMonthEnd,
        },
        status: "PAID",
      },
    });

    // Get number of active subscriptions
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        status: "ACTIVE",
        currentPeriodEnd: {
          gte: now,
        },
      },
    });

    // Calculate ARPA (handle division by zero)
    const monthlyARPA =
      activeSubscriptions > 0
        ? (monthlyRevenue._sum.amountCents || 0) / 100 / activeSubscriptions
        : 0;

    // Get historical data for the last 12 months
    const historicalData = await getHistoricalData(12);

    return res.json({
      success: true,
      data: {
        currentCustomers,
        newCustomersPerMonth,
        monthlyChurnRate,
        monthlyARPA,
        historicalData,
      },
    });
  } catch (error) {
    console.error("[BUSINESS_KPIS_ERROR]", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch business KPIs",
    });
  }
}

// Helper function to get historical data for a number of months
async function getHistoricalData(months: number) {
  const now = new Date();
  const historicalData = [];

  for (let i = 0; i < months; i++) {
    const monthDate = subMonths(now, i);
    const monthStart = startOfMonth(monthDate);
    const monthEnd = endOfMonth(monthDate);
    const previousMonthStart = startOfMonth(subMonths(monthDate, 1));

    // Current customers for this month
    const currentCustomers = await prisma.user.count({
      where: {
        activeSubscriptionId: { not: null },
        deletedAt: null,
        activeSubscription: {
          status: "ACTIVE",
          startDate: { lte: monthEnd },
        },
      },
    });

    // New customers for this month
    const newCustomers = await prisma.subscriptionHistory.count({
      where: {
        startDate: {
          gte: monthStart,
          lte: monthEnd,
        },
        // Only count new subscriptions, not renewals
        user: {
          subscriptionHistory: {
            none: {
              startDate: {
                lt: monthStart,
              },
            },
          },
        },
      },
    });

    // Customers at start of month
    const customersAtStartOfMonth = await prisma.user.count({
      where: {
        activeSubscriptionId: { not: null },
        deletedAt: null,
        activeSubscription: {
          startDate: { lt: monthStart },
        },
      },
    });

    // Churned customers during month
    const churnedCustomers = await prisma.subscriptionHistory.count({
      where: {
        status: { in: ["CANCELED", "INACTIVE"] },
        endDate: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
    });

    // Calculate churn rate
    const churnRate =
      customersAtStartOfMonth > 0
        ? (churnedCustomers / customersAtStartOfMonth) * 100
        : 0;

    // Revenue for the month
    const monthlyRevenue = await prisma.billingRecord.aggregate({
      _sum: {
        amountCents: true,
      },
      where: {
        billingDate: {
          gte: monthStart,
          lte: monthEnd,
        },
        status: "PAID",
      },
    });

    // Active subscriptions for the month
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        status: "ACTIVE",
        currentPeriodEnd: {
          gte: monthStart,
        },
      },
    });

    // Calculate ARPA
    const arpa =
      activeSubscriptions > 0
        ? (monthlyRevenue._sum.amountCents || 0) / 100 / activeSubscriptions
        : 0;

    historicalData.push({
      month: format(monthDate, "MMM yyyy"),
      currentCustomers,
      newCustomers,
      churnRate,
      arpa,
    });
  }

  // Return in chronological order (oldest to newest)
  return historicalData.reverse();
}

// Wrap the handlers to match the RequestHandler return type
const getUserStatsHandler: express.RequestHandler = async (req, res, next) => {
  try {
    await getUserStats(req, res);
  } catch (error) {
    next(error);
  }
};

const getBusinessKpisHandler: express.RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    await getBusinessKpis(req, res);
  } catch (error) {
    next(error);
  }
};

// Apply admin middleware to all routes
router.use(requireAdmin);

// Register routes
router.get("/users", getUserStatsHandler);
router.get("/business-kpis", getBusinessKpisHandler);

export default router;
