import { Request, Response } from "express";
import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
} from "@prisma/client";
import { startOfMonth, subMonths } from "date-fns";

const prisma = new PrismaClient();

export async function getUsers(req: Request, res: Response) {
  try {
    const {
      tier,
      status,
      minCredits,
      maxCredits,
      search,
      lifetimeOnly,
      creditStatus,
    } = req.query;

    // Base query for users
    const whereClause: any = {};
    const subscriptionWhereClause: any = {
      status: {
        not: SubscriptionStatus.INACTIVE,
      },
    };

    // Filter by tier
    if (tier && tier !== "all") {
      subscriptionWhereClause.tier = {
        id: tier as string,
      };
    }

    // Filter by subscription status
    if (status && status !== "all") {
      subscriptionWhereClause.status = status as SubscriptionStatus;
    }

    // Filter by search term
    if (search) {
      whereClause.OR = [
        { email: { contains: search as string, mode: "insensitive" } },
        { firstName: { contains: search as string, mode: "insensitive" } },
        { lastName: { contains: search as string, mode: "insensitive" } },
      ];
    }

    // Special handling for lifetime plan subscribers
    if (lifetimeOnly === "true") {
      subscriptionWhereClause.tier = {
        tierId: "LIFETIME" as SubscriptionTierId,
      };
    }

    // Get users with their subscriptions
    const users = await prisma.user.findMany({
      where: whereClause,
      include: {
        subscriptions: {
          where: subscriptionWhereClause,
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
          include: {
            tier: true,
          },
        },
        listingCredits: {
          where: {
            creditsRemaining: { gt: 0 },
          },
        },
      },
    });

    // Filter by credits if specified
    let filteredUsers = users;

    if (minCredits) {
      const min = parseInt(minCredits as string);
      filteredUsers = filteredUsers.filter(
        (user) => user.listingCredits.length >= min
      );
    }

    if (maxCredits) {
      const max = parseInt(maxCredits as string);
      filteredUsers = filteredUsers.filter(
        (user) => user.listingCredits.length <= max
      );
    }

    // Special handling for lifetime plan credit status
    if (lifetimeOnly === "true" && creditStatus && creditStatus !== "all") {
      // Get current month start
      const currentMonthStart = startOfMonth(new Date());
      const lastMonthStart = startOfMonth(subMonths(new Date(), 1));

      // Get credit transactions for lifetime subscribers
      const userIds = filteredUsers.map((user) => user.id);

      const creditTransactions = await prisma.creditTransaction.findMany({
        where: {
          subscription: {
            userId: { in: userIds },
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
      const userCreditStatus = new Map();

      creditTransactions.forEach((transaction) => {
        const userId = transaction.subscription.userId;
        const isCurrentMonth = transaction.createdAt >= currentMonthStart;

        if (!userCreditStatus.has(userId)) {
          userCreditStatus.set(userId, {
            receivedCurrentMonth: false,
            receivedLastMonth: false,
          });
        }

        const status = userCreditStatus.get(userId);

        if (isCurrentMonth) {
          status.receivedCurrentMonth = true;
        } else {
          status.receivedLastMonth = true;
        }
      });

      // Filter users based on credit status
      switch (creditStatus) {
        case "received":
          filteredUsers = filteredUsers.filter(
            (user) =>
              userCreditStatus.get(user.id)?.receivedCurrentMonth === true
          );
          break;
        case "pending":
          filteredUsers = filteredUsers.filter(
            (user) =>
              userCreditStatus.get(user.id)?.receivedCurrentMonth !== true
          );
          break;
        case "missed":
          filteredUsers = filteredUsers.filter(
            (user) => userCreditStatus.get(user.id)?.receivedLastMonth !== true
          );
          break;
      }

      // Add credit status to user data
      filteredUsers = filteredUsers.map((user) => {
        const creditStatus = userCreditStatus.get(user.id) || {
          receivedCurrentMonth: false,
          receivedLastMonth: false,
        };

        return {
          ...user,
          creditStatus,
        };
      });
    }

    // Format the response
    const formattedUsers = filteredUsers.map((user) => {
      const activeSubscription = user.subscriptions[0];
      const availableCredits = user.listingCredits.length;

      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        role: user.role,
        credits: availableCredits,
        subscription: activeSubscription
          ? {
              id: activeSubscription.id,
              status: activeSubscription.status,
              tier: {
                id: activeSubscription.tier.id,
                name: activeSubscription.tier.name,
                tierId: activeSubscription.tier.tierId,
              },
              startDate: activeSubscription.startDate,
              currentPeriodEnd: activeSubscription.currentPeriodEnd,
            }
          : null,
        creditStatus: (user as any).creditStatus,
      };
    });

    res.json({
      success: true,
      data: formattedUsers,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
}
