import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

export async function handleStripeWebhook(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const sig = event.headers["stripe-signature"];
    if (!sig || !webhookSecret) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Stripe signature is required" }),
      };
    }

    // Verify webhook signature
    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
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
      case "payment_intent.succeeded": {
        const paymentIntent = stripeEvent.data.object as Stripe.PaymentIntent;
        const { userId, subscriptionPlan } = paymentIntent.metadata;

        // Update user's subscription
        await prisma.user.update({
          where: { id: userId },
          data: {
            currentTierId: subscriptionPlan,
            updatedAt: new Date(),
          },
        });

        break;
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = stripeEvent.data.object as Stripe.PaymentIntent;
        console.error("Payment failed:", paymentIntent.id);
        // Optionally notify the user or take other actions
        break;
      }

      // Add other event types as needed
      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };
  } catch (error) {
    console.error("Webhook error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Webhook handler failed" }),
    };
  }
}
