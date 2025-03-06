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
    // Find user by Stripe customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: subscription.customer as string },
      include: { currentTier: true },
    });

    if (!user) {
      logger.error("No user found with Stripe customer ID", {
        customerId: subscription.customer,
      });
      return;
    }

    // Map Stripe status to our status
    const subscriptionStatus = mapStripeStatus(subscription.status);

    // Get the price ID from the subscription
    const priceId = subscription.items.data[0]?.price.id;

    // Find the corresponding tier for this price
    const tier = priceId
      ? await prisma.subscriptionTier.findUnique({
          where: { stripePriceId: priceId },
        })
      : null;

    // If no tier found, log error but continue with status update
    if (!tier && priceId) {
      logger.error("No tier found for price ID", { priceId });
    }

    // Prepare update data
    const updateData: any = {
      subscriptionStatus,
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId || null,
      subscriptionPeriodEnd: new Date(subscription.current_period_end * 1000),
    };

    // Only update tier if we found one
    if (tier) {
      updateData.currentTierId = tier.tierId;
    }

    // Update user with new status and tier if available
    await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });

    // Log the subscription change
    await prisma.subscriptionLog.create({
      data: {
        userId: user.id,
        action: "SUBSCRIPTION_UPDATED",
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId || null,
        status: subscriptionStatus,
        periodEnd: new Date(subscription.current_period_end * 1000),
      },
    });

    // If tier changed, log it
    if (tier && user.currentTierId !== tier.tierId) {
      await prisma.tierChange.create({
        data: {
          userId: user.id,
          oldTier: user.currentTierId || SubscriptionTierId.FREE,
          newTier: tier.tierId,
          reason: "Stripe subscription update",
        },
      });
    }

    // If subscription is canceled, schedule a job to downgrade to FREE tier when period ends
    if (subscriptionStatus === "CANCELED") {
      logger.info(
        "Subscription canceled, will downgrade to FREE tier after period end",
        {
          userId: user.id,
          periodEnd: new Date(subscription.current_period_end * 1000),
        }
      );
    }
  } catch (error) {
    logger.error("Error handling subscription update", { error });
    throw error;
  }
}

// Helper function to check and update subscription status
async function checkSubscriptionStatus(userId: string) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
        currentTierId: true,
      },
    });

    if (!user) return;

    // If subscription is canceled and period has ended, downgrade to FREE tier
    if (
      user.subscriptionStatus === "CANCELED" &&
      user.subscriptionPeriodEnd &&
      user.subscriptionPeriodEnd < new Date() &&
      user.currentTierId !== SubscriptionTierId.FREE
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          currentTierId: SubscriptionTierId.FREE,
          subscriptionStatus: "INACTIVE",
        },
      });

      await prisma.tierChange.create({
        data: {
          userId,
          oldTier: user.currentTierId || SubscriptionTierId.FREE,
          newTier: SubscriptionTierId.FREE,
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
            const user = await prisma.user.findFirst({
              where: { stripeCustomerId: subscription.customer as string },
            });

            if (user) {
              await prisma.$transaction(async (tx) => {
                await tx.listingCredit.create({
                  data: {
                    userId: user.id,
                    creditsRemaining: tier.creditsPerInterval,
                  },
                });
                await tx.creditLog.create({
                  data: {
                    userId: user.id,
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
        const customerId = subscription.customer as string;

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (!user) {
          logger.error("User not found for customer ID:", customerId);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "User not found" }),
          };
        }

        // Update user's subscription status but keep the tier until period ends
        await prisma.user.update({
          where: { id: user.id },
          data: {
            subscriptionStatus: "CANCELED",
            stripeSubscriptionId: null,
            stripePriceId: null,
          },
        });

        // Create subscription history entry for cancellation
        await prisma.subscriptionHistory.create({
          data: {
            userId: user.id,
            tierId: user.currentTierId!,
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

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: invoice.customer as string },
          include: { currentTier: true },
        });

        if (!user || !user.currentTier) break;

        const currentTier = user.currentTier; // Store tier reference to avoid null checks

        // Only add credits for monthly subscriptions
        if (
          currentTier.planType === "MONTHLY" &&
          currentTier.creditsPerInterval > 0
        ) {
          await prisma.$transaction(async (tx) => {
            const creditsToAdd = currentTier.creditsPerInterval;
            const tierName = currentTier.name;

            // Add new credits
            await tx.listingCredit.create({
              data: {
                userId: user.id,
                creditsRemaining: creditsToAdd,
              },
            });

            // Log the credit addition
            await tx.creditLog.create({
              data: {
                userId: user.id,
                amount: creditsToAdd,
                reason: `Monthly credits from ${tierName} subscription`,
              },
            });
          });
        }

        // Log the successful payment
        await prisma.subscriptionLog.create({
          data: {
            userId: user.id,
            action: "payment.succeeded",
            stripeSubscriptionId: subscription.id,
            status: "ACTIVE",
            periodEnd: user.subscriptionPeriodEnd,
          },
        });

        break;
      }

      case "invoice.payment_failed": {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        if (!invoice.subscription) break;

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: invoice.customer as string },
        });

        if (!user) break;

        // Update user's subscription status
        await prisma.user.update({
          where: { id: user.id },
          data: {
            subscriptionStatus: "PAST_DUE",
          },
        });

        // Log the payment failure
        await prisma.subscriptionLog.create({
          data: {
            userId: user.id,
            action: "payment.failed",
            stripeSubscriptionId: invoice.subscription as string,
            status: "PAST_DUE",
            periodEnd: user.subscriptionPeriodEnd,
          },
        });

        break;
      }

      case "checkout.session.completed": {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;

        // Only process credit purchases
        if (session.mode !== "payment") break;

        const customerId = session.customer as string;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (!user) break;

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

        if (!tier || tier.planType !== "PAY_AS_YOU_GO") break;

        const creditAmount = tier.creditsPerInterval; // Pay-as-you-go plans store credits in creditsPerInterval

        await prisma.$transaction(async (tx) => {
          // Add credits based on the plan
          await tx.listingCredit.create({
            data: {
              userId: user.id,
              creditsRemaining: creditAmount,
            },
          });

          // Log the credit addition
          await tx.creditLog.create({
            data: {
              userId: user.id,
              amount: creditAmount,
              reason: `Credits purchased from ${tier.name} plan`,
            },
          });

          logger.info("[Stripe Webhook] Added pay-as-you-go credits", {
            userId: user.id,
            tierName: tier.name,
            credits: creditAmount,
          });
        });

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
