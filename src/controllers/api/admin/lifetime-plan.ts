import { Request, Response } from "express";
import {
  PrismaClient,
  SubscriptionTierId,
  SubscriptionStatus,
} from "@prisma/client";
import { startOfMonth, subMonths } from "date-fns";

const prisma = new PrismaClient();

/**
 * Get lifetime plan statistics for the admin dashboard
 */
export async function getLifetimePlanStats(req: Request, res: Response) {
  try {
    // Get all active lifetime subscriptions
    const activeLifetimeSubscriptions = await prisma.subscription.findMany({
      where: {
        tier: {
          tierId: "LIFETIME" as SubscriptionTierId,
        },
        status: "ACTIVE" as SubscriptionStatus,
        deletedAt: null,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get current month's credit transactions for lifetime subscribers
    const currentMonthStart = startOfMonth(new Date());
    const lastMonthStart = startOfMonth(subMonths(new Date(), 1));

    const creditTransactions = await prisma.creditTransaction.findMany({
      where: {
        subscription: {
          tier: {
            tierId: "LIFETIME" as SubscriptionTierId,
          },
        },
        source: "SUBSCRIPTION_CHANGE",
        reason: "Monthly credits for lifetime subscription",
        createdAt: {
          gte: lastMonthStart,
        },
      },
      include: {
        subscription: {
          select: {
            userId: true,
          },
        },
      },
    });

    // Group transactions by user and month
    const userCredits = new Map();

    creditTransactions.forEach((transaction) => {
      const userId = transaction.subscription.userId;
      const isCurrentMonth = transaction.createdAt >= currentMonthStart;

      if (!userCredits.has(userId)) {
        userCredits.set(userId, {
          currentMonth: 0,
          lastMonth: 0,
        });
      }

      const userCredit = userCredits.get(userId);

      if (isCurrentMonth) {
        userCredit.currentMonth += transaction.amount;
      } else {
        userCredit.lastMonth += transaction.amount;
      }
    });

    // Combine subscription data with credit data
    const lifetimeSubscriberData = activeLifetimeSubscriptions.map(
      (subscription) => {
        const userId = subscription.userId;
        const creditData = userCredits.get(userId) || {
          currentMonth: 0,
          lastMonth: 0,
        };

        return {
          id: subscription.id,
          userId: userId,
          email: subscription.user.email,
          name: `${subscription.user.firstName || ""} ${
            subscription.user.lastName || ""
          }`.trim(),
          createdAt: subscription.createdAt,
          creditsBalance: subscription.creditsBalance,
          currentMonthCredits: creditData.currentMonth,
          lastMonthCredits: creditData.lastMonth,
          receivedCurrentMonth: creditData.currentMonth > 0,
          receivedLastMonth: creditData.lastMonth > 0,
        };
      }
    );

    // Get summary statistics
    const totalSubscribers = lifetimeSubscriberData.length;
    const totalCreditsBalance = lifetimeSubscriberData.reduce(
      (sum, subscriber) => sum + subscriber.creditsBalance,
      0
    );
    const subscribersWithCurrentMonthCredits = lifetimeSubscriberData.filter(
      (subscriber) => subscriber.receivedCurrentMonth
    ).length;
    const subscribersWithLastMonthCredits = lifetimeSubscriberData.filter(
      (subscriber) => subscriber.receivedLastMonth
    ).length;

    return res.json({
      success: true,
      data: {
        summary: {
          totalSubscribers,
          totalCreditsBalance,
          subscribersWithCurrentMonthCredits,
          subscribersWithLastMonthCredits,
          currentMonth: currentMonthStart.toISOString(),
          lastMonth: lastMonthStart.toISOString(),
        },
        subscribers: lifetimeSubscriberData,
      },
    });
  } catch (error) {
    console.error("Error fetching lifetime plan stats:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch lifetime plan statistics",
    });
  }
}
