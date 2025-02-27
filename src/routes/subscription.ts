import { PrismaClient, SubscriptionTierId } from "@prisma/client";
import express, { Request, Response } from "express";
import Stripe from "stripe";
import { z } from "zod";
import {
  isValidTierId,
  SUBSCRIPTION_TIERS,
} from "../constants/subscription-tiers.js";
import { isAuthenticated } from "../middleware/auth.js";
import { validateRequest } from "../middleware/validate.js";
import { createApiResponse } from "../types/api.js";
const router = express.Router();
const prisma = new PrismaClient();

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is required");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
});

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

// Validation schema for create checkout
const createCheckoutSchema = z.object({
  body: z.object({
    plan: z.string().min(1),
    billingType: z.enum(["credits", "monthly"]),
    returnUrl: z.string().url(),
  }),
});

interface ListingWithCounts {
  id: string;
  status: string;
  _count: {
    photos: number;
    videoJobs: number;
  };
}

// Get available subscription tiers
const getTiers = async (_req: Request, res: Response) => {
  try {
    const tiers = await prisma.subscriptionTier.findMany({
      orderBy: [{ createdAt: "asc" }],
    });

    const tiersWithNames = tiers.map((tier) => ({
      ...tier,
      name: tier.name,
    }));

    res.json(createApiResponse(true, tiersWithNames));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to get tiers"
        )
      );
  }
};

// Update user's subscription tier
const updateTier = async (req: Request, res: Response) => {
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
      where: { id: userId },
      data: {
        currentTierId: tier.tierId,
      },
      select: {
        id: true,
        currentTierId: true,
      },
    });

    // Log the tier change
    await prisma.tierChange.create({
      data: {
        userId: user.id,
        oldTier: currentUser.currentTierId || tierId,
        newTier: tier.tierId,
        reason: "User initiated change",
      },
    });

    res.json({
      success: true,
      data: {
        userId: user.id,
        tier: user.currentTierId,
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

// Create checkout session
const createCheckout = async (req: Request, res: Response) => {
  try {
    // Get user ID from the request body since it's passed from the frontend
    const { userId, plan, billingType, returnUrl } = req.body;

    if (!userId) {
      res.status(400).json({
        success: false,
        error: "User ID is required",
      });
      return;
    }

    // Get the user to check if they have a Stripe customer ID
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        stripeCustomerId: true,
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    // Get the subscription tier for the selected plan
    const tier = await prisma.subscriptionTier.findFirst({
      where: {
        AND: [
          { name: plan }, // Exact match since we're now sending the correct plan name
          { planType: billingType === "monthly" ? "MONTHLY" : "PAY_AS_YOU_GO" },
        ],
      },
    });

    if (!tier) {
      console.error("Plan not found:", { plan, billingType });
      res.status(404).json({
        success: false,
        error: "Plan not found",
      });
      return;
    }

    // Create or retrieve Stripe customer
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: user.id,
        },
      });
      stripeCustomerId = customer.id;

      // Update user with Stripe customer ID
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId },
      });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      line_items: [
        {
          price: tier.stripePriceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: returnUrl,
      subscription_data: {
        metadata: {
          userId,
          tierId: tier.id,
        },
      },
    });

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        url: session.url,
      },
    });
  } catch (error) {
    console.error("Create checkout error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Update subscription from Stripe
const updateSubscriptionFromStripe = async (req: Request, res: Response) => {
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
const cancelSubscription = async (req: Request, res: Response) => {
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

    res.json(
      createApiResponse(
        true,
        updatedUser,
        "Subscription cancelled successfully"
      )
    );
  } catch (error) {
    console.error("Cancel subscription error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get current user's subscription
const getCurrentSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        currentTierId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
        stripePriceId: true,
      },
    });

    if (!user) {
      res
        .status(404)
        .json(createApiResponse(false, undefined, undefined, "User not found"));
      return;
    }

    res.json(
      createApiResponse(true, {
        id: user.stripeSubscriptionId || user.id,
        plan: user.currentTierId,
        status: user.subscriptionStatus?.toLowerCase() || "free",
        currentPeriodEnd:
          user.subscriptionPeriodEnd?.toISOString() || new Date().toISOString(),
        cancelAtPeriodEnd: user.subscriptionStatus === "CANCELED",
      })
    );
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to get subscription"
        )
      );
  }
};

// Get user's invoices
const getInvoices = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 10;
    const starting_after = req.query.starting_after as string;

    // Get user's Stripe customer ID
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        stripeCustomerId: true,
      },
    });

    if (!user?.stripeCustomerId) {
      res.status(404).json({
        success: false,
        error: "User not found or no Stripe customer ID",
      });
      return;
    }

    // Fetch invoices from Stripe with pagination
    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit: Math.min(limit, 100), // Cap at 100 to prevent abuse
      starting_after,
    });

    const formattedInvoices = invoices.data.map((invoice) => ({
      id: invoice.id,
      created: invoice.created,
      amount_paid: invoice.amount_paid,
      status: invoice.status,
      invoice_pdf: invoice.invoice_pdf,
    }));

    res.json({
      success: true,
      data: {
        invoices: formattedInvoices,
        has_more: invoices.has_more,
      },
    });
  } catch (error) {
    console.error("Get invoices error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get user's usage statistics
const getUsageStats = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get user's current subscription and usage data
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        currentTier: true,
        listings: {
          select: {
            id: true,
            status: true,
            _count: {
              select: {
                photos: true,
                videoJobs: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    // Calculate usage statistics
    const activeListings = user.listings.filter(
      (listing: ListingWithCounts) => listing.status === "ACTIVE"
    ).length;

    const totalListings = user.listings.length;
    const totalVideosGenerated = user.listings.reduce(
      (sum: number, listing: ListingWithCounts) =>
        sum + listing._count.videoJobs,
      0
    );
    const totalPhotos = user.listings.reduce(
      (sum: number, listing: ListingWithCounts) => sum + listing._count.photos,
      0
    );

    // Calculate storage used (assuming each photo is ~2MB and each video is ~10MB)
    const storageUsed = totalPhotos * 2 + totalVideosGenerated * 10;

    // Get credits used from the credit logs table
    const creditsUsed = await prisma.creditLog.aggregate({
      where: {
        userId,
        amount: { lt: 0 }, // Only count negative amounts (used credits)
        createdAt: {
          gte: new Date(new Date().setDate(1)), // Start of current month
        },
      },
      _sum: {
        amount: true,
      },
    });

    res.json({
      success: true,
      data: {
        creditsUsed: Math.abs(creditsUsed._sum.amount || 0),
        activeListings,
        totalListings,
        totalVideosGenerated,
        storageUsed,
      },
    });
  } catch (error) {
    console.error("Get usage stats error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Ensure user has a subscription tier
const ensureTier = async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;

    // Get user with their current tier
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        currentTier: true,
        listings: {
          where: { status: "ACTIVE" },
          select: { id: true },
        },
      },
    });

    if (!user) {
      res
        .status(404)
        .json(createApiResponse(false, undefined, undefined, "User not found"));
      return;
    }

    // If user has no tier, assign free trial tier
    if (!user.currentTierId) {
      const freeTier = await prisma.subscriptionTier.findFirst({
        where: { tierId: SubscriptionTierId.FREE },
      });

      if (!freeTier) {
        res
          .status(500)
          .json(
            createApiResponse(
              false,
              undefined,
              undefined,
              "Free tier not found"
            )
          );
        return;
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          currentTierId: freeTier.tierId,
          subscriptionStatus: "TRIALING",
        },
      });

      res.json(
        createApiResponse(true, {
          tier: {
            maxActiveListings: freeTier.maxActiveListings,
            name: freeTier.name,
            currentCount: user.listings.length,
          },
        })
      );
      return;
    }

    // Return current tier info
    if (!user.currentTier) {
      res
        .status(500)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "Current tier not found"
          )
        );
      return;
    }

    res.json(
      createApiResponse(true, {
        tier: {
          maxActiveListings: user.currentTier.maxActiveListings,
          name: user.currentTier.name,
          currentCount: user.listings.length,
        },
      })
    );
  } catch (error) {
    console.error("Ensure tier error:", error);
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to ensure tier"
        )
      );
  }
};

// Route handlers
router.get("/tiers", getTiers);
router.patch(
  "/tier",
  isAuthenticated,
  validateRequest(updateTierSchema),
  updateTier
);
router.post(
  "/create-checkout",
  isAuthenticated,
  validateRequest(createCheckoutSchema),
  createCheckout
);
router.post(
  "/update",
  validateRequest(updateSubscriptionSchema),
  updateSubscriptionFromStripe
);
router.post("/cancel", isAuthenticated, cancelSubscription);
router.get("/current", isAuthenticated, getCurrentSubscription);
router.get("/invoices", isAuthenticated, getInvoices);
router.get("/usage", isAuthenticated, getUsageStats);
router.post("/ensure-tier", isAuthenticated, ensureTier);

export default router;
