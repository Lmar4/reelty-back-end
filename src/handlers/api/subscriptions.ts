import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

// Validation schemas
const updateSubscriptionSchema = z.object({
  userId: z.string().uuid(),
  subscriptionTier: z.string()
});

export async function updateSubscription(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Request body is required' })
      };
    }

    const body = JSON.parse(event.body);
    const validatedData = updateSubscriptionSchema.parse(body);

    // Verify subscription tier exists
    const tierExists = await prisma.subscriptionTier.findUnique({
      where: { id: validatedData.subscriptionTier }
    });

    if (!tierExists) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid subscription tier' })
      };
    }

    // Update user's subscription
    const updatedUser = await prisma.user.update({
      where: { id: validatedData.userId },
      data: { subscriptionTier: validatedData.subscriptionTier },
      select: {
        id: true,
        subscriptionTier: true,
        updatedAt: true
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify(updatedUser)
    };

  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Validation error', 
          details: error.errors 
        })
      };
    }

    console.error('Error updating subscription:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
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
        description: true,
        pricing: true,
        features: true
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify(tiers)
    };

  } catch (error) {
    console.error('Error fetching subscription tiers:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}
