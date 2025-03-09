import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
} from "@prisma/client";
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
    tierId: z.string().uuid(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
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
      },
    });

    if (!currentUser) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    // Get the active subscription
    const activeSubscription = currentUser.subscriptions[0];

    // Create or update subscription
    let subscription;

    // Check if user already has an active subscription
    if (activeSubscription) {
      // Update existing subscription
      subscription = await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          tierId: tier.tierId,
        },
      });
    } else {
      // Create new subscription
      subscription = await prisma.subscription.create({
        data: {
          userId: userId,
          tierId: tier.tierId,
          status: "ACTIVE",
        },
      });

      // Update user's active subscription reference
      await prisma.user.update({
        where: { id: userId },
        data: {
          activeSubscriptionId: subscription.id,
        },
      });
    }

    // Log the tier change
    await prisma.tierChange.create({
      data: {
        userId: userId,
        oldTier: activeSubscription?.tierId || tierId,
        newTier: tier.tierId,
        reason: "User initiated change",
      },
    });

    res.json({
      success: true,
      data: {
        userId: userId,
        tier: tier.tierId,
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
    const { tierId, successUrl, cancelUrl } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json(createApiResponse(false, null, "Unauthorized"));
      return;
    }

    // Get the tier
    const tier = await prisma.subscriptionTier.findUnique({
      where: { tierId: tierId as SubscriptionTierId },
    });

    if (!tier) {
      res.status(404).json(createApiResponse(false, null, "Tier not found"));
      return;
    }

    // Get the user
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
      },
    });

    if (!user) {
      res.status(404).json(createApiResponse(false, null, "User not found"));
      return;
    }

    // Get the active subscription
    const activeSubscription = user.subscriptions[0];

    // Create or get Stripe customer
    let stripeCustomerId = activeSubscription?.stripeCustomerId;

    // If no customer ID from subscription, check if we need to create one
    if (!stripeCustomerId) {
      // Check if we already have customers with this email
      const existingCustomers = await stripe.customers.list({
        email: user.email,
        limit: 1,
      });

      if (existingCustomers.data.length > 0) {
        stripeCustomerId = existingCustomers.data[0].id;
      } else {
        // Create a new customer
        const customer = await stripe.customers.create({
          email: user.email,
          name:
            `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
            user.email,
          metadata: {
            userId: user.id,
          },
        });

        stripeCustomerId = customer.id;
      }
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ["card"],
      line_items: [
        {
          price: tier.stripePriceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: user.id,
        tierId: tier.tierId,
      },
    });

    res.json(createApiResponse(true, { url: session.url }));
  } catch (error) {
    console.error("Error creating checkout:", error);
    res
      .status(500)
      .json(
        createApiResponse(false, null, "Failed to create checkout session")
      );
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

    // Find the subscription tier by Stripe price ID
    const tier = await prisma.subscriptionTier.findFirst({
      where: { stripePriceId },
    });

    if (!tier) {
      return res.status(404).json({
        success: false,
        error: "Subscription tier not found",
      });
    }

    // Find existing subscription or create a new one
    let subscription = await prisma.subscription.findFirst({
      where: {
        userId,
        stripeSubscriptionId,
      },
    });

    if (subscription) {
      // Update existing subscription
      subscription = await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          stripeSubscriptionId,
          stripePriceId,
          tierId: tier.id,
          status: status as SubscriptionStatus,
          currentPeriodEnd: new Date(currentPeriodEnd * 1000),
          updatedAt: new Date(),
        },
      });
    } else {
      // Create new subscription
      subscription = await prisma.subscription.create({
        data: {
          userId,
          tierId: tier.id,
          stripeSubscriptionId,
          stripePriceId,
          status: status as SubscriptionStatus,
          currentPeriodEnd: new Date(currentPeriodEnd * 1000),
        },
      });
    }

    // Update user's active subscription
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        activeSubscriptionId: subscription.id,
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

    // Find the user with their active subscription
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        activeSubscription: true,
      },
    });

    if (!user || !user.activeSubscription) {
      return res.status(404).json({
        success: false,
        error: "User or active subscription not found",
      });
    }

    // Update the subscription status
    await prisma.subscription.update({
      where: { id: user.activeSubscription.id },
      data: {
        status: "CANCELED",
      },
    });

    // Log the cancellation
    await prisma.subscriptionLog.create({
      data: {
        userId: user.id,
        action: "cancel",
        stripeSubscriptionId,
        status: "canceled",
      },
    });

    res.json(
      createApiResponse(true, user, "Subscription cancelled successfully")
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
      },
    });

    if (!user) {
      res
        .status(404)
        .json(createApiResponse(false, undefined, undefined, "User not found"));
      return;
    }

    // Get the active subscription
    const activeSubscription = user.subscriptions[0];

    // Access subscription fields safely with correct field names
    const currentPeriodEnd = activeSubscription?.currentPeriodEnd || new Date();
    const stripeCustomerId = activeSubscription?.stripeCustomerId;

    // If no active subscription, return a default "free" subscription
    if (!activeSubscription) {
      res.json(
        createApiResponse(true, {
          id: user.id,
          plan: SubscriptionTierId.FREE,
          status: "free",
          currentPeriodEnd: new Date().toISOString(),
          cancelAtPeriodEnd: false,
        })
      );
      return;
    }

    res.json(
      createApiResponse(true, {
        id: activeSubscription.id,
        plan: activeSubscription.tierId,
        status: activeSubscription.status.toLowerCase(),
        currentPeriodEnd:
          activeSubscription.currentPeriodEnd?.toISOString() ||
          new Date().toISOString(),
        cancelAtPeriodEnd: activeSubscription.status === "CANCELED",
        tierName: activeSubscription.tier.name,
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

    // Get user's active subscription with Stripe customer ID
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        activeSubscription: true,
      },
    });

    if (
      !user ||
      !user.activeSubscription ||
      !user.activeSubscription.stripeCustomerId
    ) {
      res.status(404).json({
        success: false,
        error:
          "User not found or no active subscription with Stripe customer ID",
      });
      return;
    }

    // Fetch invoices from Stripe with pagination
    const invoices = await stripe.invoices.list({
      customer: user.activeSubscription.stripeCustomerId,
      limit: Math.min(limit, 100), // Cap at 100 to prevent abuse
      starting_after,
    });

    // Format the response
    const formattedInvoices = invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      created: new Date(invoice.created * 1000).toISOString(),
      period_start: new Date(invoice.period_start * 1000).toISOString(),
      period_end: new Date(invoice.period_end * 1000).toISOString(),
      amount_due: invoice.amount_due / 100, // Convert from cents to dollars
      amount_paid: invoice.amount_paid / 100,
      status: invoice.status,
      hosted_invoice_url: invoice.hosted_invoice_url,
    }));

    res.json({
      success: true,
      data: {
        invoices: formattedInvoices,
        has_more: invoices.has_more,
      },
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to fetch invoices",
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

    // Get the active subscription
    const activeSubscription = user.subscriptions[0];

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

    // Get subscription tier limits
    const tierLimits = activeSubscription?.tier
      ? {
          maxActiveListings: activeSubscription.tier.maxActiveListings,
          name: activeSubscription.tier.name,
          maxPhotosPerListing: activeSubscription.tier.maxPhotosPerListing,
          maxVideosPerListing: activeSubscription.tier.maxPhotosPerListing || 1,
        }
      : {
          maxActiveListings: 1,
          name: "Free",
          maxPhotosPerListing: 5,
          maxVideosPerListing: 1,
        };

    res.json({
      success: true,
      data: {
        usage: {
          activeListings,
          totalListings,
          totalVideosGenerated,
          totalPhotos,
        },
        limits: tierLimits,
        currentCount: activeListings,
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
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json(createApiResponse(false, null, "Unauthorized"));
      return;
    }

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
          include: {
            tier: true,
          },
        },
        listings: true,
      },
    });

    if (!user) {
      res.status(404).json(createApiResponse(false, null, "User not found"));
      return;
    }

    // Get the active subscription
    const activeSubscription = user.subscriptions[0];

    // If user doesn't have an active subscription, assign the free tier
    if (!activeSubscription) {
      const freeTier = await prisma.subscriptionTier.findUnique({
        where: { tierId: SubscriptionTierId.FREE },
      });

      if (!freeTier) {
        res
          .status(500)
          .json(createApiResponse(false, null, "Free tier not found"));
        return;
      }

      // Create a new subscription with the free tier
      const newSubscription = await prisma.subscription.create({
        data: {
          userId: user.id,
          tierId: freeTier.id,
          status: SubscriptionStatus.ACTIVE,
        },
      });

      // Update the user's active subscription
      await prisma.user.update({
        where: { id: user.id },
        data: {
          activeSubscriptionId: newSubscription.id,
        },
      });

      // Return the tier info
      res.json(
        createApiResponse(true, {
          maxActiveListings: freeTier.maxActiveListings,
          name: freeTier.name,
          currentCount: user.listings.length,
        })
      );
      return;
    }

    // User has an active subscription, return the tier info
    res.json(
      createApiResponse(true, {
        maxActiveListings: activeSubscription.tier.maxActiveListings,
        name: activeSubscription.tier.name,
        currentCount: user.listings.length,
      })
    );
  } catch (error) {
    console.error("Error ensuring tier:", error);
    res
      .status(500)
      .json(createApiResponse(false, null, "Failed to ensure tier"));
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
  (req: Request, res: Response) => {
    updateSubscriptionFromStripe(req, res).catch((err) => {
      console.error("Error in updateSubscriptionFromStripe:", err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error occurred",
      });
    });
  }
);
router.post("/cancel", isAuthenticated, (req: Request, res: Response) => {
  cancelSubscription(req, res).catch((err) => {
    console.error("Error in cancelSubscription:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Unknown error occurred",
    });
  });
});
router.get("/current", isAuthenticated, getCurrentSubscription);
router.get("/invoices", isAuthenticated, getInvoices);
router.get("/usage", isAuthenticated, getUsageStats);
router.post("/ensure-tier", isAuthenticated, ensureTier);

export default router;
