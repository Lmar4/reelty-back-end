import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();

// Validation schemas
const updateSubscriptionSchema = z.object({
  userId: z.string().uuid(),
  stripeSubscriptionId: z.string(),
  stripePriceId: z.string(),
  stripeProductId: z.string(),
  status: z.enum([
    "ACTIVE",
    "CANCELED",
    "PAST_DUE",
    "INCOMPLETE",
    "INCOMPLETE_EXPIRED",
  ]),
  currentPeriodEnd: z.number(),
});

const cancelSubscriptionSchema = z.object({
  userId: z.string().uuid(),
  stripeSubscriptionId: z.string(),
});

export async function updateSubscription(
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
    const validatedData = updateSubscriptionSchema.parse(body);

    // Update user's subscription
    const updatedUser = await prisma.user.update({
      where: { id: validatedData.userId },
      data: {
        subscriptions: {
          update: {
            where: {
              id: validatedData.stripeSubscriptionId,
            },
            data: {
              status: validatedData.status.toUpperCase() as SubscriptionStatus,
              currentPeriodEnd: new Date(validatedData.currentPeriodEnd * 1000),
            },
          },
        },
        updatedAt: new Date(),
      },
    });

    // Log the subscription update
    await prisma.subscriptionLog.create({
      data: {
        userId: validatedData.userId,
        action: "update",
        stripeSubscriptionId: validatedData.stripeSubscriptionId,
        stripePriceId: validatedData.stripePriceId,
        stripeProductId: validatedData.stripeProductId,
        status: validatedData.status.toUpperCase(),
        periodEnd: new Date(validatedData.currentPeriodEnd * 1000),
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify(updatedUser),
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

    console.error("Error updating subscription:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

export async function cancelSubscription(
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
    const validatedData = cancelSubscriptionSchema.parse(body);

    // Update user's subscription status
    const updatedUser = await prisma.user.update({
      where: { id: validatedData.userId },
      data: {
        subscriptions: {
          update: {
            where: { id: validatedData.stripeSubscriptionId },
            data: { status: "CANCELED" as SubscriptionStatus },
          },
        },
        updatedAt: new Date(),
      },
    });

    // Log the cancellation
    await prisma.subscriptionLog.create({
      data: {
        userId: validatedData.userId,
        action: "cancel",
        stripeSubscriptionId: validatedData.stripeSubscriptionId,
        status: "CANCELED",
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify(updatedUser),
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

    console.error("Error canceling subscription:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

export async function getSubscriptionTiers(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const tiers = await prisma.subscriptionTier.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        stripePriceId: true,
        stripeProductId: true,
        features: true,
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify(tiers),
    };
  } catch (error) {
    console.error("Error fetching subscription tiers:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
