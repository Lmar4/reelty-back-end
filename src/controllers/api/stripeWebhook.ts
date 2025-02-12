import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import Stripe from "stripe";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
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
    if (!request.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const sig = request.headers["stripe-signature"];
    if (!sig || !webhookSecret || Array.isArray(sig)) {
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
    } catch (err) {
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
        const priceId = subscription.items.data[0].price.id;
        const customerId = subscription.customer as string;

        // Find tier by Stripe price ID
        const tier = await prisma.subscriptionTier.findFirst({
          where: { stripePriceId: priceId },
        });

        if (!tier) {
          console.error("Tier not found for price ID:", priceId);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "Subscription tier not found" }),
          };
        }

        // Find user by Stripe customer ID
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (!user) {
          console.error("User not found for customer ID:", customerId);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "User not found" }),
          };
        }

        const subscriptionStatus = mapStripeStatus(subscription.status);

        // Update user subscription details
        await prisma.user.update({
          where: { id: user.id },
          data: {
            currentTierId: tier.id,
            stripeSubscriptionId: subscription.id,
            stripePriceId: priceId,
            subscriptionStatus,
            subscriptionPeriodEnd: new Date(
              subscription.current_period_end * 1000
            ),
          },
        });

        // Create subscription history entry
        await prisma.subscriptionHistory.create({
          data: {
            userId: user.id,
            tierId: tier.id,
            status: subscriptionStatus,
            startDate: new Date(subscription.current_period_start * 1000),
            endDate: new Date(subscription.current_period_end * 1000),
          },
        });

        // Log the subscription change
        await prisma.subscriptionLog.create({
          data: {
            userId: user.id,
            action: stripeEvent.type,
            stripeSubscriptionId: subscription.id,
            stripePriceId: priceId,
            stripeProductId: tier.stripeProductId,
            status: subscriptionStatus,
            periodEnd: new Date(subscription.current_period_end * 1000),
          },
        });

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (!user) {
          console.error("User not found for customer ID:", customerId);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "User not found" }),
          };
        }

        // Update user's subscription status
        await prisma.user.update({
          where: { id: user.id },
          data: {
            subscriptionStatus: "CANCELED",
            currentTierId: null,
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
            endDate: new Date(),
          },
        });

        // Log the cancellation
        await prisma.subscriptionLog.create({
          data: {
            userId: user.id,
            action: "subscription.canceled",
            stripeSubscriptionId: subscription.id,
            status: "CANCELED",
            periodEnd: new Date(),
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
        });

        if (!user) break;

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

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    console.error("Webhook error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Webhook handler failed" }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  }
}
