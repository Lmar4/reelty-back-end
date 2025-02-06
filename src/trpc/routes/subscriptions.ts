import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../types";
import { prisma } from "../../lib/prisma";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-01-27.acacia",
});

export const subscriptionRouter = router({
  getTiers: publicProcedure.query(async () => {
    const tiers = await prisma.subscriptionTier.findMany({
      orderBy: { pricing: "asc" },
    });
    return tiers;
  }),

  updateTier: protectedProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        tierId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is updating their own subscription
      if (input.userId !== ctx.user.uid) {
        throw new Error(
          "Unauthorized: You can only update your own subscription"
        );
      }

      const tier = await prisma.subscriptionTier.findUnique({
        where: { id: input.tierId },
      });
      if (!tier) {
        throw new Error("Subscription tier not found");
      }

      const user = await prisma.user.update({
        where: { id: input.userId },
        data: { subscriptionTier: tier.id },
      });
      return user;
    }),

  createCheckoutSession: protectedProcedure
    .input(
      z.object({
        priceId: z.string(),
        userId: z.string().uuid(),
        successUrl: z.string().url(),
        cancelUrl: z.string().url(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is creating checkout for themselves
      if (input.userId !== ctx.user.uid) {
        throw new Error(
          "Unauthorized: You can only create checkout for yourself"
        );
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price: input.priceId,
            quantity: 1,
          },
        ],
        mode: "subscription",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.userId,
      });

      return session.url;
    }),

  getUserCredits: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Verify user is accessing their own credits
      if (input.userId !== ctx.user.uid) {
        throw new Error("Unauthorized: You can only access your own credits");
      }

      const credits = await prisma.listingCredit.findMany({
        where: {
          userId: input.userId,
          expiryDate: { gt: new Date() },
        },
        orderBy: { expiryDate: "asc" },
      });
      return credits;
    }),
});
