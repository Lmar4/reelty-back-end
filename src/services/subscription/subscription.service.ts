import {
  PrismaClient,
  SubscriptionTier,
  User,
  SubscriptionStatus,
  Prisma,
  SubscriptionTierId,
  PlanType,
} from "@prisma/client";
import { plansService } from "../stripe/plans.service.js";
import { logger } from "../../utils/logger.js";
import Stripe from "stripe";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-02-24.acacia",
});

export interface CreateSubscriptionTierInput {
  tierId: SubscriptionTierId;
  name: string;
  description: string;
  monthlyPriceCents: number;
  planType: "PAY_AS_YOU_GO" | "MONTHLY";
  features: string[];
  creditsPerInterval: number;
  hasWatermark: boolean;
  maxPhotosPerListing: number;
  maxReelDownloads?: number | null;
  maxActiveListings: number;
  premiumTemplatesEnabled: boolean;
}

export interface UpdateSubscriptionTierInput
  extends Partial<CreateSubscriptionTierInput> {
  id: string;
}

export class SubscriptionService {
  private static instance: SubscriptionService;

  private constructor() {}

  public static getInstance(): SubscriptionService {
    if (!SubscriptionService.instance) {
      SubscriptionService.instance = new SubscriptionService();
    }
    return SubscriptionService.instance;
  }

  async createSubscriptionTier(
    input: CreateSubscriptionTierInput
  ): Promise<SubscriptionTier> {
    try {
      // First create the Stripe product and price
      const { product, price } = await plansService.syncPlan(
        {
          tierId: String(input.tierId) as any,
          name: input.name,
          description: input.description,
          monthlyPriceCents: input.monthlyPriceCents,
          planType: input.planType as PlanType,
        },
        {
          features: input.features,
          maxListings: input.maxActiveListings,
          maxPhotosPerListing: input.maxPhotosPerListing,
          maxVideosPerMonth: input.maxReelDownloads || 0,
          customBranding: !input.hasWatermark,
          analytics: true,
          priority: 1,
          premiumTemplatesEnabled: input.premiumTemplatesEnabled,
        }
      );

      // Then create the subscription tier with Stripe IDs
      const tier = await prisma.subscriptionTier.create({
        data: {
          tierId: input.tierId,
          name: input.name,
          description: input.description,
          monthlyPriceCents: input.monthlyPriceCents,
          planType: input.planType,
          features: input.features,
          creditsPerInterval: input.creditsPerInterval,
          hasWatermark: input.hasWatermark,
          maxPhotosPerListing: input.maxPhotosPerListing,
          maxReelDownloads: input.maxReelDownloads,
          maxActiveListings: input.maxActiveListings,
          premiumTemplatesEnabled: input.premiumTemplatesEnabled,
          stripeProductId: product.id,
          stripePriceId: price.id,
        },
      });

      return tier;
    } catch (error) {
      logger.error("Error creating subscription tier:", error);
      throw error;
    }
  }

  async updateSubscriptionTier(
    input: UpdateSubscriptionTierInput
  ): Promise<SubscriptionTier> {
    try {
      // First update the Stripe product and price
      if (input.name || input.description || input.monthlyPriceCents) {
        await plansService.syncPlan(
          {
            tierId:
              input.tierId as import("../stripe/plans.service.js").SubscriptionTierId,
            name: input.name,
            description: input.description,
            monthlyPriceCents: input.monthlyPriceCents,
            planType: input.planType as PlanType,
          },
          {
            features: input.features || [],
            maxListings: input.maxActiveListings || 0,
            maxPhotosPerListing: input.maxPhotosPerListing || 0,
            maxVideosPerMonth: input.maxReelDownloads || 0,
            customBranding: !input.hasWatermark,
            analytics: true,
            priority: 1,
            premiumTemplatesEnabled: input.premiumTemplatesEnabled || false,
          }
        );
      }

      // Then update the subscription tier
      const tier = await prisma.subscriptionTier.update({
        where: { id: input.id },
        data: {
          name: input.name,
          description: input.description,
          monthlyPriceCents: input.monthlyPriceCents,
          planType: input.planType,
          features: input.features,
          creditsPerInterval: input.creditsPerInterval,
          hasWatermark: input.hasWatermark,
          maxPhotosPerListing: input.maxPhotosPerListing,
          maxReelDownloads: input.maxReelDownloads,
          maxActiveListings: input.maxActiveListings,
          premiumTemplatesEnabled: input.premiumTemplatesEnabled,
        },
      });

      return tier;
    } catch (error) {
      logger.error("Error updating subscription tier:", error);
      throw error;
    }
  }

  async deleteSubscriptionTier(id: string): Promise<void> {
    try {
      const tier = await prisma.subscriptionTier.findUnique({
        where: { id },
        include: { users: true },
      });

      if (!tier) {
        throw new Error("Subscription tier not found");
      }

      if (tier.users.length > 0) {
        throw new Error("Cannot delete tier with active users");
      }

      // Deactivate the Stripe product if it exists
      if (tier.stripeProductId) {
        try {
          // Archive the product in Stripe
          await stripe.products.update(tier.stripeProductId, {
            active: false,
          });

          // Archive the price in Stripe
          if (tier.stripePriceId) {
            await stripe.prices.update(tier.stripePriceId, {
              active: false,
            });
          }
        } catch (stripeError) {
          logger.error("Error archiving Stripe product/price:", stripeError);
          // Continue with deletion even if Stripe archival fails
        }
      }

      await prisma.subscriptionTier.delete({
        where: { id },
      });
    } catch (error) {
      logger.error("Error deleting subscription tier:", error);
      throw error;
    }
  }

  async getSubscriptionTier(id: string): Promise<SubscriptionTier | null> {
    try {
      return await prisma.subscriptionTier.findUnique({
        where: { id },
      });
    } catch (error) {
      logger.error("Error getting subscription tier:", error);
      throw error;
    }
  }

  async listSubscriptionTiers(): Promise<SubscriptionTier[]> {
    try {
      return await prisma.subscriptionTier.findMany({
        orderBy: { monthlyPriceCents: "asc" },
      });
    } catch (error) {
      logger.error("Error listing subscription tiers:", error);
      throw error;
    }
  }

  async assignTierToUser(userId: string, tierId: string): Promise<User> {
    try {
      // Get the tier
      const tier = await prisma.subscriptionTier.findUnique({
        where: { id: tierId },
      });

      if (!tier) {
        throw new Error(`Subscription tier with ID ${tierId} not found`);
      }

      // Get the user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          subscriptions: {
            where: {
              status: {
                not: SubscriptionStatus.INACTIVE,
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
          },
        },
      });

      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }

      // Check if user already has an active subscription
      const activeSubscription = user.subscriptions[0];

      if (activeSubscription) {
        // Update existing subscription
        await prisma.subscription.update({
          where: { id: activeSubscription.id },
          data: {
            tierId: tier.id,
            status: SubscriptionStatus.ACTIVE,
          },
        });
      } else {
        // Create new subscription
        const newSubscription = await prisma.subscription.create({
          data: {
            userId,
            tierId: tier.id,
            status: SubscriptionStatus.ACTIVE,
          },
        });

        // Set as active subscription
        await prisma.user.update({
          where: { id: userId },
          data: {
            activeSubscriptionId: newSubscription.id,
          },
        });
      }

      // Log the tier change
      await prisma.tierChange.create({
        data: {
          userId,
          oldTier: activeSubscription?.tierId || SubscriptionTierId.FREE,
          newTier: tier.tierId,
          reason: "Admin assigned tier",
        },
      });

      // Return the updated user
      return (await prisma.user.findUnique({
        where: { id: userId },
        include: {
          subscriptions: {
            where: {
              status: {
                not: SubscriptionStatus.INACTIVE,
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
            include: {
              tier: true,
            },
          },
        },
      })) as User;
    } catch (error) {
      logger.error("Error assigning tier to user:", error);
      throw error;
    }
  }

  async checkUserSubscription(userId: string): Promise<{
    isActive: boolean;
    tier: SubscriptionTier | null;
    status: SubscriptionStatus;
  }> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          subscriptions: {
            where: {
              status: {
                not: SubscriptionStatus.INACTIVE,
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
            include: {
              tier: true,
            },
          },
        },
      });

      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }

      const activeSubscription = user.subscriptions[0];
      const tier = activeSubscription?.tier || null;
      const status = activeSubscription?.status || SubscriptionStatus.INACTIVE;

      return {
        isActive: status === SubscriptionStatus.ACTIVE,
        tier,
        status,
      };
    } catch (error) {
      logger.error("Error checking user subscription:", error);
      throw error;
    }
  }
}

export const subscriptionService = SubscriptionService.getInstance();
