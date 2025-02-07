import express, { RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { getAuth } from "@clerk/express";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const updateTierSchema = z.object({
  body: z.object({
    tierId: z.string().min(1),
  }),
});

// Get available subscription tiers
const getTiers: RequestHandler = async (_req, res) => {
  try {
    const tiers = await prisma.subscriptionTier.findMany({
      where: {
        isAdmin: false, // Don't expose admin tiers
      },
      orderBy: {
        pricing: "asc",
      },
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
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { tierId } = req.body;

    // Verify tier exists and is not an admin tier
    const tier = await prisma.subscriptionTier.findFirst({
      where: {
        id: tierId,
        isAdmin: false,
      },
    });

    if (!tier) {
      res.status(404).json({
        success: false,
        error: "Invalid subscription tier",
      });
      return;
    }

    // Update user's tier
    const user = await prisma.user.update({
      where: {
        id: auth.userId,
      },
      data: {
        subscriptionTier: tierId,
      },
      include: {
        tier: true,
      },
    });

    // Log the tier change
    await prisma.tierChange.create({
      data: {
        userId: auth.userId,
        oldTier: user.subscriptionTier,
        newTier: tierId,
        reason: "User initiated change",
      },
    });

    res.json({
      success: true,
      data: {
        userId: user.id,
        tier: user.tier,
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
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    // TODO: Implement your payment provider integration here
    // This is a placeholder that returns a mock checkout session
    res.json({
      success: true,
      data: {
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

// Route handlers
router.get("/tiers", getTiers);
router.patch("/tier", validateRequest(updateTierSchema), updateTier);
router.post("/checkout", initiateCheckout);

export default router;
