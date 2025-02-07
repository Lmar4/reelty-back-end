import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { z } from 'zod';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-01-27.acacia'
});

const paymentIntentSchema = z.object({
  userId: z.string().uuid(),
  subscriptionPlan: z.string()
});

export async function createPaymentIntent(
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
    const validatedData = paymentIntentSchema.parse(body);

    // Get subscription tier details
    const tier = await prisma.subscriptionTier.findUnique({
      where: { id: validatedData.subscriptionPlan }
    });

    if (!tier) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid subscription plan' })
      };
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(tier.pricing) * 100), // Convert to cents
      currency: 'usd',
      metadata: {
        userId: validatedData.userId,
        subscriptionPlan: validatedData.subscriptionPlan
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      })
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

    if (error instanceof Stripe.errors.StripeError) {
      return {
        statusCode: error.statusCode || 500,
        body: JSON.stringify({ 
          error: error.message 
        })
      };
    }

    console.error('Error creating payment intent:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}
