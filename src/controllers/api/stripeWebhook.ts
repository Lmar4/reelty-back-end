import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
} from "@prisma/client";
import Stripe from "stripe";
import { logger } from "../../utils/logger.js";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-02-24.acacia",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Helper function to map Stripe status to Prisma SubscriptionStatus
function mapStripeStatus(status: string): SubscriptionStatus {
  const statusMap: Record<string, SubscriptionStatus> = {
    active: "ACTIVE",
    canceled: "CANCELED",
    incomplete: "INCOMPLETE",
    incomplete_expired: "INCOMPLETE_EXPIRED",
    past_due: "PAST_DUE",
    trialing: "TRIALING",
    unpaid: "UNPAID",
  };
  return statusMap[status] || "INACTIVE";
}

// Helper function to handle subscription updates
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  try {
    const status = mapStripeStatus(subscription.status);
    const customerId = subscription.customer as string;
    const subscriptionId = subscription.id;
    const priceId = subscription.items.data[0]?.price.id;
    const productId = subscription.items.data[0]?.price.product as string;

    // Find user by Stripe customer ID
    const user = await prisma.user.findFirst({
      where: {
        subscriptions: {
          some: {
            stripeCustomerId: customerId,
          },
        },
      },
      include: {
        subscriptions: {
          where: {
            stripeSubscriptionId: subscriptionId,
          },
          include: {
            tier: true,
          },
        },
      },
    });

    if (!user) {
      logger.error(`No user found with Stripe customer ID ${customerId}`);
      return;
    }

    const existingSubscription = user.subscriptions[0];

    if (!existingSubscription) {
      logger.error(
        `No subscription found for user ${user.id} with Stripe subscription ID ${subscriptionId}`
      );
      return;
    }

    // Find the subscription tier by Stripe price ID
    const tier = await prisma.subscriptionTier.findFirst({
      where: { stripePriceId: priceId },
    });

    // Update the subscription
    await prisma.subscription.update({
      where: { id: existingSubscription.id },
      data: {
        status,
        stripeSubscriptionId: subscriptionId,
        stripePriceId: priceId,
        tierId: tier?.id || existingSubscription.tierId,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : undefined,
        canceledAt: subscription.canceled_at
          ? new Date(subscription.canceled_at * 1000)
          : null,
      },
    });

    // If tier changed, log it
    if (tier && existingSubscription.tierId !== tier.id) {
      await prisma.tierChange.create({
        data: {
          userId: user.id,
          oldTier: existingSubscription.tierId,
          newTier: tier.tierId,
          reason: "Stripe subscription update",
        },
      });
    }

    // Log the subscription update
    await prisma.subscriptionLog.create({
      data: {
        userId: user.id,
        action: "UPDATED_FROM_STRIPE",
        stripeSubscriptionId: subscriptionId,
        stripePriceId: priceId,
        stripeProductId: productId,
        status,
      },
    });

    logger.info(`Updated subscription for user ${user.id}`);
  } catch (error) {
    logger.error("Error handling subscription update:", error);
  }
}

// Helper function to check and update subscription status
async function checkSubscriptionStatus(userId: string) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        activeSubscription: {
          include: {
            tier: true,
          },
        },
      },
    });

    if (!user || !user.activeSubscription) return;

    // If subscription is canceled and period has ended, downgrade to FREE tier
    if (
      user.activeSubscription.status === "CANCELED" &&
      user.activeSubscription.currentPeriodEnd &&
      user.activeSubscription.currentPeriodEnd < new Date() &&
      user.activeSubscription.tier.tierId !== SubscriptionTierId.FREE
    ) {
      // Find the FREE tier
      const freeTier = await prisma.subscriptionTier.findFirst({
        where: { tierId: SubscriptionTierId.FREE },
      });

      if (!freeTier) {
        logger.error("FREE tier not found in database");
        return;
      }

      // Create a new subscription with FREE tier
      const newSubscription = await prisma.subscription.create({
        data: {
          userId,
          tierId: freeTier.id,
          status: "INACTIVE",
        },
      });

      // Update user's active subscription
      await prisma.user.update({
        where: { id: userId },
        data: {
          activeSubscriptionId: newSubscription.id,
        },
      });

      await prisma.tierChange.create({
        data: {
          userId,
          oldTier: user.activeSubscription.tierId,
          newTier: freeTier.id,
          reason: "Subscription period ended",
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId,
          action: "DOWNGRADED_TO_FREE",
          stripeSubscriptionId: "period_ended",
          status: "INACTIVE",
        },
      });

      logger.info(
        "User downgraded to FREE tier after subscription period ended",
        {
          userId,
        }
      );
    }
  } catch (error) {
    logger.error("Error checking subscription status", { error, userId });
  }
}

interface WebhookRequest {
  body: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
}

interface WebhookResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

export async function handleStripeWebhook(
  request: WebhookRequest
): Promise<WebhookResponse> {
  try {
    logger.info("[STRIPE_WEBHOOK] Received webhook request");

    if (!request.body) {
      logger.error("[STRIPE_WEBHOOK] No request body");
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const sig = request.headers["stripe-signature"];
    if (!sig || !webhookSecret || Array.isArray(sig)) {
      logger.error("[STRIPE_WEBHOOK] Invalid signature", {
        sig,
        webhookSecret,
      });
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid stripe signature" }),
      };
    }

    // Verify webhook signature
    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        request.body,
        sig,
        webhookSecret
      );
      logger.info("[STRIPE_WEBHOOK] Event verified", {
        type: stripeEvent.type,
      });
    } catch (err) {
      logger.error("[STRIPE_WEBHOOK] Signature verification failed:", err);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid signature" }),
      };
    }

    // Handle different event types
    switch (stripeEvent.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = stripeEvent.data.object as Stripe.Subscription;

        // Use the new helper function
        await handleSubscriptionUpdated(subscription);

        // If this is a new subscription, add initial credits
        if (stripeEvent.type === "customer.subscription.created") {
          const priceId = subscription.items.data[0]?.price.id;
          const tier = priceId
            ? await prisma.subscriptionTier.findUnique({
                where: { stripePriceId: priceId },
              })
            : null;

          if (
            tier &&
            tier.planType === "MONTHLY" &&
            tier.creditsPerInterval > 0
          ) {
            // Find the user by looking up the subscription with this Stripe subscription ID
            const existingSubscription = await prisma.subscription.findFirst({
              where: { stripeSubscriptionId: subscription.id },
              include: { user: true },
            });

            if (existingSubscription && existingSubscription.user) {
              await prisma.$transaction(async (tx) => {
                await tx.listingCredit.create({
                  data: {
                    userId: existingSubscription.user.id,
                    creditsRemaining: tier.creditsPerInterval,
                  },
                });
                await tx.creditLog.create({
                  data: {
                    userId: existingSubscription.user.id,
                    amount: tier.creditsPerInterval,
                    reason: `Initial credits from ${tier.name} subscription`,
                  },
                });
              });
            }
          }
        }

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = stripeEvent.data.object as Stripe.Subscription;

        // Find the subscription and associated user
        const existingSubscription = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: subscription.id },
          include: { user: true },
        });

        if (!existingSubscription || !existingSubscription.user) break;

        const user = existingSubscription.user;

        // Update the subscription status
        await prisma.subscription.update({
          where: { id: existingSubscription.id },
          data: {
            status: "CANCELED",
            canceledAt: new Date(),
          },
        });

        // Create a subscription history record
        await prisma.subscriptionHistory.create({
          data: {
            userId: user.id,
            tierId: existingSubscription.tierId,
            status: "CANCELED",
            startDate: new Date(),
            endDate: new Date(subscription.current_period_end * 1000),
          },
        });

        // Log the cancellation
        await prisma.subscriptionLog.create({
          data: {
            userId: user.id,
            action: "subscription.canceled",
            stripeSubscriptionId: subscription.id,
            status: "CANCELED",
            periodEnd: new Date(subscription.current_period_end * 1000),
          },
        });

        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        if (!invoice.subscription) break;

        const subscription = await stripe.subscriptions.retrieve(
          invoice.subscription as string
        );

        // Find the subscription and associated user
        const existingSubscription = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: subscription.id },
          include: {
            user: true,
            tier: true,
          },
        });

        if (
          !existingSubscription ||
          !existingSubscription.user ||
          !existingSubscription.tier
        )
          break;

        const user = existingSubscription.user;
        const tier = existingSubscription.tier;

        // Only add credits for monthly subscriptions
        if (tier.planType === "MONTHLY" && tier.creditsPerInterval > 0) {
          await prisma.$transaction(async (tx) => {
            // Add credits to the user
            await tx.listingCredit.create({
              data: {
                userId: user.id,
                creditsRemaining: tier.creditsPerInterval,
              },
            });

            // Log the credit addition
            await tx.creditLog.create({
              data: {
                userId: user.id,
                amount: tier.creditsPerInterval,
                reason: `Monthly credits from ${tier.name} subscription`,
              },
            });
          });
        }

        break;
      }

      case "invoice.payment_failed": {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        if (!invoice.subscription) break;

        // Find the subscription and associated user
        const existingSubscription = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: invoice.subscription as string },
          include: { user: true },
        });

        if (!existingSubscription || !existingSubscription.user) break;

        // Update subscription status
        await prisma.subscription.update({
          where: { id: existingSubscription.id },
          data: {
            status: "PAST_DUE",
          },
        });

        // Log the payment failure
        await prisma.subscriptionLog.create({
          data: {
            userId: existingSubscription.user.id,
            action: "payment.failed",
            stripeSubscriptionId: invoice.subscription as string,
            status: "PAST_DUE",
            periodEnd: existingSubscription.currentPeriodEnd,
          },
        });

        break;
      }

      case "checkout.session.completed": {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;

        // Only process credit purchases
        if (session.mode !== "payment") break;

        const customerId = session.customer as string;

        // Find subscriptions with this customer ID
        const existingSubscription = await prisma.subscription.findFirst({
          where: { stripeCustomerId: customerId },
          include: { user: true },
        });

        if (!existingSubscription || !existingSubscription.user) break;

        const user = existingSubscription.user;

        // Get the price ID from the session
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id
        );
        const priceId = lineItems.data[0]?.price?.id;

        if (!priceId) break;

        // Find the tier/plan that was purchased
        const tier = await prisma.subscriptionTier.findFirst({
          where: { stripePriceId: priceId },
        });

        if (!tier) break;

        // Process the purchase based on the tier
        if (tier.planType === "PAY_AS_YOU_GO" && tier.creditsPerInterval > 0) {
          await prisma.$transaction(async (tx) => {
            // Add credits to the user
            await tx.listingCredit.create({
              data: {
                userId: user.id,
                creditsRemaining: tier.creditsPerInterval,
              },
            });

            // Log the credit addition
            await tx.creditLog.create({
              data: {
                userId: user.id,
                amount: tier.creditsPerInterval,
                reason: `Credit pack purchase: ${tier.name}`,
              },
            });
          });
        }

        break;
      }

      default:
        logger.info(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    logger.error("Webhook error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Webhook handler failed" }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  }
}

// Export the helper function for use in other parts of the application
export { checkSubscriptionStatus };
