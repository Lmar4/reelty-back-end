import { PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import Stripe from "stripe";
import { z } from "zod";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-02-24.acacia",
});

const paymentIntentSchema = z.object({
  userId: z.string(),
  subscriptionPlan: z.string(),
});

// Schema for subscription tier sync
const tierSyncSchema = z.object({
  tierId: z.string(),
});

// Schema for checkout session
const checkoutSessionSchema = z.object({
  userId: z.string(),
  tierId: z.string(),
});

// Define metadata type for subscription tiers
interface TierMetadata {
  maxListings: number;
  maxPhotosPerListing: number;
  maxVideosPerMonth: number;
  features: string[];
}

export async function createPaymentIntent(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const validatedData = paymentIntentSchema.parse(req.body);

    // Get subscription tier details
    const tier = await prisma.subscriptionTier.findUnique({
      where: { id: validatedData.subscriptionPlan },
    });

    if (!tier) {
      res.status(400).json({ error: "Invalid subscription plan" });
      return;
    }

    if (!tier.monthlyPriceCents || tier.monthlyPriceCents < 0) {
      res.status(400).json({ error: "Invalid subscription price" });
      return;
    }

    // Use the price in cents directly
    const amount = tier.monthlyPriceCents;
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "Invalid price calculation" });
      return;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      metadata: {
        userId: validatedData.userId,
        subscriptionPlan: validatedData.subscriptionPlan,
      },
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: error.errors,
      });
      return;
    }

    if (error instanceof Stripe.errors.StripeError) {
      res.status(error.statusCode || 500).json({
        error: error.message,
      });
      return;
    }

    console.error("Error creating payment intent:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function syncSubscriptionTier(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { tierId } = tierSyncSchema.parse(req.body);

    const tier = await prisma.subscriptionTier.findUnique({
      where: { id: tierId },
    });

    if (!tier) {
      res.status(404).json({ error: "Subscription tier not found" });
      return;
    }

    // Create or update Stripe product
    const productData = {
      name: tier.name,
      description: tier.description,
      metadata: {
        tierId: tier.id,
        features: JSON.stringify(tier.features),
      },
    };

    let product: Stripe.Product;
    let price: Stripe.Price;

    if (tier.stripeProductId) {
      // Update existing product
      product = await stripe.products.update(tier.stripeProductId, productData);
    } else {
      // Create new product
      product = await stripe.products.create(productData);
    }

    // Create or update price
    const priceData = {
      unit_amount: tier.monthlyPriceCents, // Already in cents
      currency: "usd",
      recurring: { interval: "month" as const },
      product: product.id,
      metadata: { tierId: tier.id },
    };

    if (tier.stripePriceId) {
      // Archive old price
      await stripe.prices.update(tier.stripePriceId, { active: false });
    }

    // Always create a new price (Stripe best practice)
    price = await stripe.prices.create(priceData);

    // Update tier with new Stripe IDs
    await prisma.subscriptionTier.update({
      where: { id: tier.id },
      data: {
        stripeProductId: product.id,
        stripePriceId: price.id,
      },
    });

    res.status(200).json({ product, price });
  } catch (error) {
    console.error("Error syncing with Stripe:", error);
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: error.errors,
      });
      return;
    }

    res.status(500).json({ error: "Failed to sync with Stripe" });
  }
}

export async function createCheckoutSession(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { userId, tierId } = checkoutSessionSchema.parse(req.body);

    // Get user and tier details
    const [user, tier] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.subscriptionTier.findUnique({
        where: { id: tierId },
      }),
    ]);

    if (!user || !tier) {
      res.status(404).json({ error: "User or tier not found" });
      return;
    }

    if (!tier.stripePriceId) {
      res.status(400).json({ error: "Tier not synced with Stripe" });
      return;
    }

    // Parse tier metadata
    const metadata: TierMetadata = {
      maxListings: tier.maxActiveListings,
      maxPhotosPerListing: tier.maxPhotosPerListing,
      maxVideosPerMonth: tier.maxReelDownloads || 0,
      features: tier.features as unknown as string[], // Type assertion for JSON field
    };

    // Get user's active subscription
    const activeSubscription = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        status: 'ACTIVE',
      },
    });
    
    // Create or get Stripe customer
    let customerId = activeSubscription?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      
      // Update or create subscription with Stripe customer ID
      if (activeSubscription) {
        await prisma.subscription.update({
          where: { id: activeSubscription.id },
          data: { stripeCustomerId: customerId },
        });
      } else {
        // Create a new subscription if none exists
        await prisma.subscription.create({
          data: {
            userId: user.id,
            stripeCustomerId: customerId,
            status: 'INCOMPLETE',
            tierId: tier.id,
          },
        });
      }
    }

    // Create checkout session with metadata
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: tier.stripePriceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          userId,
          tierId,
          tierName: tier.name,
          maxListings: metadata.maxListings,
          maxPhotosPerListing: metadata.maxPhotosPerListing,
          maxVideosPerMonth: metadata.maxVideosPerMonth,
          features: JSON.stringify(metadata.features),
        },
      },
      success_url: `${process.env.FRONTEND_URL}/settings/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/settings/billing`,
    });

    res.status(200).json({ sessionId: session.id, sessionUrl: session.url });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: error.errors,
      });
      return;
    }

    res.status(500).json({ error: "Failed to create checkout session" });
  }
}
