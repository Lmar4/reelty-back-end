import {
  PrismaClient,
  SubscriptionTier,
  User,
  SubscriptionStatus,
  Prisma,
  SubscriptionTierId,
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
  monthlyPrice: number;
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
      // First create a Stripe product and price
      const { product, price } = await plansService.syncPlan(
        {
          ...input,
          tierId: undefined, // Remove tierId from the sync data
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
          monthlyPrice: input.monthlyPrice,
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
      const tier = await prisma.subscriptionTier.update({
        where: { id: input.id },
        data: {
          name: input.name,
          description: input.description,
          monthlyPrice: input.monthlyPrice,
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

      if (tier) {
        // Sync updated tier with Stripe
        const { tierId, ...tierData } = tier;
        await plansService.syncPlan(tierData, {
          features: tier.features,
          maxListings: tier.maxActiveListings,
          maxPhotosPerListing: tier.maxPhotosPerListing,
          maxVideosPerMonth: tier.maxReelDownloads || 0,
          customBranding: !tier.hasWatermark,
          analytics: true,
          priority: 1,
          premiumTemplatesEnabled: tier.premiumTemplatesEnabled,
        });
      }

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
        orderBy: { monthlyPrice: "asc" },
      });
    } catch (error) {
      logger.error("Error listing subscription tiers:", error);
      throw error;
    }
  }

  async assignTierToUser(userId: string, tierId: string): Promise<User> {
    try {
      const [user, tier] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.subscriptionTier.findUnique({ where: { id: tierId } }),
      ]);

      if (!user || !tier) {
        throw new Error("User or tier not found");
      }

      // Create subscription history record
      await prisma.subscriptionHistory.create({
        data: {
          userId,
          tierId,
          status: SubscriptionStatus.ACTIVE,
          startDate: new Date(),
        },
      });

      // Update user with new tier
      return await prisma.user.update({
        where: { id: userId },
        data: {
          currentTierId: tier.tierId,
          subscriptionStatus: SubscriptionStatus.ACTIVE,
        },
      });
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
        include: { currentTier: true },
      });

      if (!user) {
        throw new Error("User not found");
      }

      return {
        isActive: user.subscriptionStatus === SubscriptionStatus.ACTIVE,
        tier: user.currentTier,
        status: user.subscriptionStatus,
      };
    } catch (error) {
      logger.error("Error checking user subscription:", error);
      throw error;
    }
  }
}

export const subscriptionService = SubscriptionService.getInstance();
