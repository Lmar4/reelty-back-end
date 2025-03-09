import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isAdmin as requireAdmin } from "../../middleware/auth.js";
import { validateRequest } from "../../middleware/validate.js";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const creditAdjustmentSchema = z.object({
  body: z.object({
    amount: z.number(),
    reason: z.string().min(1),
  }),
});

const statusUpdateSchema = z.object({
  body: z.object({
    status: z.enum([
      "ACTIVE",
      "CANCELED",
      "INCOMPLETE",
      "INCOMPLETE_EXPIRED",
      "PAST_DUE",
      "TRIALING",
      "UNPAID",
      "INACTIVE",
    ]),
  }),
});

// User handlers
const listUsers: RequestHandler = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
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
        subscriptionLogs: true,
      },
    });

    // Get credit counts for all users
    const userCredits = await Promise.all(
      users.map(async (user) => {
        const availableCredits = await prisma.listingCredit.count({
          where: {
            userId: user.id,
            creditsRemaining: { gt: 0 },
          },
        });
        const activeSubscription = user.subscriptions[0];
        return {
          ...user,
          credits: availableCredits,
          currentTier: activeSubscription?.tier || null,
        };
      })
    );

    res.json({
      success: true,
      data: userCredits,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

const adjustUserCredits: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    if (amount > 0) {
      // Add new listing credits
      await prisma.$transaction(
        Array.from({ length: amount }, () =>
          prisma.listingCredit.create({
            data: {
              userId,
              creditsRemaining: 1,
            },
          })
        )
      );
    } else if (amount < 0) {
      // Remove unused credits
      const creditsToRemove = -amount; // Convert negative to positive
      const unusedCredits = await prisma.listingCredit.findMany({
        where: {
          userId,
          creditsRemaining: { gt: 0 },
        },
        orderBy: {
          createdAt: "asc",
        },
        take: creditsToRemove,
      });

      if (unusedCredits.length < creditsToRemove) {
        throw new Error("Not enough unused credits to remove");
      }

      await prisma.listingCredit.deleteMany({
        where: {
          id: { in: unusedCredits.map((c) => c.id) },
        },
      });
    }

    // Create credit adjustment log
    await prisma.creditLog.create({
      data: {
        userId,
        amount,
        reason,
        adminId: req.user?.id,
      },
    });

    // Get updated credit count
    const availableCredits = await prisma.listingCredit.count({
      where: {
        userId,
        creditsRemaining: { gt: 0 },
      },
    });

    res.json({
      success: true,
      data: { credits: availableCredits },
    });
  } catch (error) {
    console.error("Adjust credits error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

const updateUserStatus: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    // Find the user's active subscription
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
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
        },
        subscriptionLogs: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const activeSubscription = user.subscriptions[0];

    if (activeSubscription) {
      // Update the subscription status
      await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          status: status as SubscriptionStatus,
        },
      });
    }

    // Log the status change
    await prisma.subscriptionLog.create({
      data: {
        userId,
        action: "STATUS_UPDATED_BY_ADMIN",
        status,
        stripeSubscriptionId:
          activeSubscription?.stripeSubscriptionId || "admin_update",
      },
    });

    res.json({
      success: true,
      message: "User status updated successfully",
    });
  } catch (error) {
    console.error("Error updating user status:", error);
    res.status(500).json({ error: "Failed to update user status" });
  }
};

// Apply admin middleware to all routes
router.use(requireAdmin);

// Register routes
router.get("/", listUsers);
router.post(
  "/:userId/credits",
  validateRequest(creditAdjustmentSchema),
  adjustUserCredits
);
router.patch(
  "/:userId/status",
  validateRequest(statusUpdateSchema),
  updateUserStatus
);

export default router;
