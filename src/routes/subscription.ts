import { PrismaClient } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isValidTierId } from "../constants/subscription-tiers";
import { isAuthenticated } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const updateTierSchema = z.object({
  body: z.object({
    tierId: z
      .string()
      .uuid()
      .refine((val) => isValidTierId(val), {
        message: "Invalid subscription tier ID",
      }),
  }),
});

const updateSubscriptionSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    stripeSubscriptionId: z.string().min(1),
    stripePriceId: z.string().min(1),
    stripeProductId: z.string().min(1),
    status: z.string().min(1),
    currentPeriodEnd: z.number(),
  }),
});

// Get available subscription tiers
const getTiers: RequestHandler = async (_req, res) => {
  try {
    const tiers = await prisma.subscriptionTier.findMany({
      orderBy: [
        {
          createdAt: "asc",
        },
      ],
    });

    res.json({
      success: true,
      data: tiers,
    });
  } catch (error) {
    console.error("Get tiers error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Update user's subscription tier
const updateTier: RequestHandler = async (req, res) => {
  try {
    const { tierId } = req.body;
    const userId = req.user!.id;

    // Additional validation using the constant
    if (!isValidTierId(tierId)) {
      res.status(400).json({
        success: false,
        error: "Invalid subscription tier",
      });
      return;
    }

    // Verify tier exists
    const tier = await prisma.subscriptionTier.findUnique({
      where: {
        id: tierId,
      },
    });

    if (!tier) {
      res.status(404).json({
        success: false,
        error: "Invalid subscription tier",
      });
      return;
    }

    // Get current user data
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        currentTierId: true,
      },
    });

    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    // Update user's tier
    const user = await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        currentTierId: tierId,
      },
      select: {
        id: true,
        currentTier: true,
      },
    });

    // Log the tier change
    await prisma.tierChange.create({
      data: {
        userId: user.id,
        oldTier: currentUser.currentTierId || tierId,
        newTier: tierId,
        reason: "User initiated change",
      },
    });

    res.json({
      success: true,
      data: {
        userId: user.id,
        tier: user.currentTier,
      },
    });
  } catch (error) {
    console.error("Update tier error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Initiate checkout process
const initiateCheckout: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;

    // TODO: Implement your payment provider integration here
    // This is a placeholder that returns a mock checkout session
    res.json({
      success: true,
      data: {
        userId,
        checkoutUrl: "https://your-payment-provider.com/checkout/session-id",
        sessionId: "mock-session-id",
      },
    });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Update subscription from Stripe
const updateSubscriptionFromStripe: RequestHandler = async (req, res) => {
  try {
    const {
      userId,
      stripeSubscriptionId,
      stripePriceId,
      stripeProductId,
      status,
      currentPeriodEnd,
    } = req.body;

    // Update user's subscription
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        stripeSubscriptionId,
        stripePriceId,
        stripeProductId,
        subscriptionStatus: status,
        subscriptionPeriodEnd: new Date(currentPeriodEnd * 1000),
        updatedAt: new Date(),
      },
    });

    // Log the subscription update
    await prisma.subscriptionLog.create({
      data: {
        userId: updatedUser.id,
        action: "update",
        stripeSubscriptionId,
        stripePriceId,
        stripeProductId,
        status,
        periodEnd: new Date(currentPeriodEnd * 1000),
      },
    });

    res.json({
      success: true,
      data: updatedUser,
    });
  } catch (error) {
    console.error("Update subscription error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Cancel subscription
const cancelSubscription: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { stripeSubscriptionId } = req.body;

    // Update user's subscription status
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: "CANCELED",
        updatedAt: new Date(),
      },
    });

    // Log the cancellation
    await prisma.subscriptionLog.create({
      data: {
        userId: updatedUser.id,
        action: "cancel",
        stripeSubscriptionId,
        status: "canceled",
      },
    });

    res.json({
      success: true,
      data: updatedUser,
    });
  } catch (error) {
    console.error("Cancel subscription error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.get("/tiers", getTiers); // Public endpoint
router.patch(
  "/tier",
  isAuthenticated,
  validateRequest(updateTierSchema),
  updateTier
);
router.post("/checkout", isAuthenticated, initiateCheckout);
router.post(
  "/update",
  validateRequest(updateSubscriptionSchema),
  updateSubscriptionFromStripe
); // Stripe webhook endpoint
router.post("/cancel", isAuthenticated, cancelSubscription);

export default router;
