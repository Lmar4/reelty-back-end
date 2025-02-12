import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { z } from "zod";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
});

const paymentIntentSchema = z.object({
  userId: z.string().uuid(),
  subscriptionPlan: z.string(),
});

// Schema for subscription tier sync
const tierSyncSchema = z.object({
  tierId: z.string().uuid(),
});

// Schema for checkout session
const checkoutSessionSchema = z.object({
  userId: z.string().uuid(),
  tierId: z.string().uuid(),
});

export async function createPaymentIntent(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const body = JSON.parse(event.body);
    const validatedData = paymentIntentSchema.parse(body);

    // Get subscription tier details
    const tier = await prisma.subscriptionTier.findUnique({
      where: { id: validatedData.subscriptionPlan },
    });

    if (!tier) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid subscription plan" }),
      };
    }

    if (!tier.monthlyPrice || tier.monthlyPrice < 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid subscription price" }),
      };
    }

    // Create PaymentIntent with safe price conversion
    const amount = Math.round(tier.monthlyPrice * 100);
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid price calculation" }),
      };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      metadata: {
        userId: validatedData.userId,
        subscriptionPlan: validatedData.subscriptionPlan,
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
      }),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Validation error",
          details: error.errors,
        }),
      };
    }

    if (error instanceof Stripe.errors.StripeError) {
      return {
        statusCode: error.statusCode || 500,
        body: JSON.stringify({
          error: error.message,
        }),
      };
    }

    console.error("Error creating payment intent:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

export async function syncSubscriptionTier(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const body = JSON.parse(event.body);
    const { tierId } = tierSyncSchema.parse(body);

    const tier = await prisma.subscriptionTier.findUnique({
      where: { id: tierId },
    });

    if (!tier) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Subscription tier not found" }),
      };
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
      unit_amount: Math.round(tier.monthlyPrice * 100),
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

    return {
      statusCode: 200,
      body: JSON.stringify({ product, price }),
    };
  } catch (error) {
    console.error("Error syncing with Stripe:", error);
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Validation error",
          details: error.errors,
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to sync with Stripe" }),
    };
  }
}

export async function createCheckoutSession(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const body = JSON.parse(event.body);
    const { userId, tierId } = checkoutSessionSchema.parse(body);

    // Get user and tier details
    const [user, tier] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.subscriptionTier.findUnique({ where: { id: tierId } }),
    ]);

    if (!user || !tier) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "User or tier not found" }),
      };
    }

    if (!tier.stripePriceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Tier not synced with Stripe" }),
      };
    }

    // Create or get Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    // Create checkout session
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
      success_url: `${process.env.FRONTEND_URL}/settings/billing?session_id={CHECKOUT_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/settings/billing`,
      metadata: {
        userId,
        tierId,
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ sessionId: session.id, sessionUrl: session.url }),
    };
  } catch (error) {
    console.error("Error creating checkout session:", error);
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Validation error",
          details: error.errors,
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to create checkout session" }),
    };
  }
}
