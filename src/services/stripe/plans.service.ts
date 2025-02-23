import {
  PrismaClient,
  SubscriptionTier,
  PlanType,
  SubscriptionStatus,
} from "@prisma/client";
import Stripe from "stripe";

import { logger } from "../../utils/logger";
import { ProductionPipeline } from "../imageProcessing/productionPipeline";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
});

const prisma = new PrismaClient();

export enum SubscriptionTierId {
  FREE = "FREE",
  REELTY = "REELTY",
  REELTY_PRO = "REELTY_PRO",
  REELTY_PRO_PLUS = "REELTY_PRO_PLUS",
}

export interface PlanMetadata {
  features: string[];
  maxListings: number;
  maxPhotosPerListing: number;
  maxVideosPerMonth: number;
  customBranding: boolean;
  analytics: boolean;
  priority: number;
  premiumTemplatesEnabled: boolean;
}

export interface PlanFeatures {
  maxPhotosPerListing: number;
  unlimitedDownloads: boolean;
  noWatermark: boolean;
  premiumTemplates: boolean;
  prioritySupport: boolean;
  creditsPerInterval?: number;
  savePercentage?: number;
}

interface TierData
  extends Partial<
    Omit<
      SubscriptionTier,
      "planType" | "creditsPerInterval" | "premiumTemplatesEnabled"
    >
  > {
  planType?: PlanType;
  creditsPerInterval?: number;
  premiumTemplatesEnabled?: boolean;
  tierId?: SubscriptionTierId;
}

export class PlansService {
  // Create or update a subscription plan
  async syncPlan(tier: TierData, metadata: PlanMetadata) {
    try {
      if (!tier.name || !tier.description || !tier.tierId) {
        throw new Error("Name, description, and tierId are required");
      }

      // First, check if a tier with these Stripe IDs already exists
      const existingTier = await prisma.subscriptionTier.findFirst({
        where: {
          OR: [
            { id: tier.tierId },
            { name: tier.name },
            { stripeProductId: tier.stripeProductId },
            { stripePriceId: tier.stripePriceId },
          ],
        },
      });

      const stripeMetadata: Stripe.MetadataParam = {
        tierId: existingTier?.id || "",
        features: JSON.stringify(metadata.features),
        maxListings: metadata.maxListings.toString(),
        maxPhotosPerListing: metadata.maxPhotosPerListing.toString(),
        maxVideosPerMonth: metadata.maxVideosPerMonth.toString(),
        customBranding: metadata.customBranding.toString(),
        analytics: metadata.analytics.toString(),
        priority: metadata.priority.toString(),
        premiumTemplatesEnabled:
          metadata.premiumTemplatesEnabled?.toString() || "false",
      };

      // Create or update Stripe product
      let product: Stripe.Product;
      if (existingTier?.stripeProductId) {
        product = await stripe.products.update(existingTier.stripeProductId, {
          name: tier.name,
          description: tier.description,
          metadata: stripeMetadata,
        });
      } else {
        product = await stripe.products.create({
          name: tier.name,
          description: tier.description,
          metadata: stripeMetadata,
        });
      }

      // Create new price (Stripe best practice is to create new price and archive old)
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(tier.monthlyPrice! * 100),
        currency: "usd",
        recurring:
          tier.planType === "MONTHLY" ? { interval: "month" } : undefined,
        metadata: { tierId: existingTier?.id || "" },
      });

      // Archive old price if it exists
      if (existingTier?.stripePriceId) {
        await stripe.prices.update(existingTier.stripePriceId, {
          active: false,
        });
      }

      // Update product with default price
      await stripe.products.update(product.id, {
        default_price: price.id,
      });

      // Prepare subscription tier data
      const subscriptionTierData = {
        tierId: tier.tierId,
        name: tier.name,
        description: tier.description,
        monthlyPrice: tier.monthlyPrice!,
        planType: tier.planType || "PAY_AS_YOU_GO",
        creditsPerInterval: tier.creditsPerInterval || 0,
        features: metadata.features,
        maxPhotosPerListing: tier.maxPhotosPerListing || 20,
        hasWatermark: tier.hasWatermark ?? true,
        maxReelDownloads: tier.maxReelDownloads,
        maxActiveListings: tier.maxActiveListings || 15,
        premiumTemplatesEnabled: tier.premiumTemplatesEnabled ?? false,
        stripeProductId: product.id,
        stripePriceId: price.id,
      };

      // Update or create subscription tier in database
      if (existingTier) {
        await prisma.subscriptionTier.update({
          where: { id: existingTier.id },
          data: subscriptionTierData,
        });
      } else {
        await prisma.subscriptionTier.create({
          data: subscriptionTierData,
        });
      }

      return { product, price };
    } catch (error) {
      console.error("Error syncing plan:", error);
      throw error;
    }
  }

  async getActivePlans() {
    const products = await stripe.products.list({
      active: true,
      expand: ["data.default_price"],
    });

    return products.data.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      metadata: this.parseMetadata(product.metadata),
      price: (product.default_price as Stripe.Price)?.unit_amount ?? 0,
      priceId: (product.default_price as Stripe.Price)?.id,
    }));
  }

  async getPlanDetails(productId: string) {
    const product = await stripe.products.retrieve(productId, {
      expand: ["default_price"],
    });

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      metadata: this.parseMetadata(product.metadata),
      price: (product.default_price as Stripe.Price)?.unit_amount ?? 0,
      priceId: (product.default_price as Stripe.Price)?.id,
    };
  }

  private parseMetadata(metadata: Stripe.Metadata): PlanMetadata {
    return {
      features: JSON.parse(metadata.features || "[]"),
      maxListings: parseInt(metadata.maxListings || "0"),
      maxPhotosPerListing: parseInt(metadata.maxPhotosPerListing || "0"),
      maxVideosPerMonth: parseInt(metadata.maxVideosPerMonth || "0"),
      customBranding: metadata.customBranding === "true",
      analytics: metadata.analytics === "true",
      priority: parseInt(metadata.priority || "0"),
      premiumTemplatesEnabled: metadata.premiumTemplatesEnabled === "true",
    };
  }

  async createPricingPlans() {
    const plans = [
      // Pay As You Go Plans
      {
        name: "1 Credit",
        type: "PAY_AS_YOU_GO" as PlanType,
        price: 59,
        credits: 1,
        tierId: SubscriptionTierId.FREE,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: false,
        },
      },
      {
        name: "4 Credits",
        type: "PAY_AS_YOU_GO" as PlanType,
        price: 236,
        credits: 4,
        tierId: SubscriptionTierId.REELTY,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: false,
        },
      },
      {
        name: "10 Credits",
        type: "PAY_AS_YOU_GO" as PlanType,
        price: 590,
        credits: 10,
        tierId: SubscriptionTierId.REELTY_PRO,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: false,
        },
      },
      // Monthly Subscription Plans
      {
        name: "Reelty",
        type: "MONTHLY" as PlanType,
        price: 39,
        creditsPerInterval: 1,
        tierId: SubscriptionTierId.REELTY,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: true,
          savePercentage: 34,
        },
      },
      {
        name: "Reelty Pro",
        type: "MONTHLY" as PlanType,
        price: 129,
        creditsPerInterval: 4,
        tierId: SubscriptionTierId.REELTY_PRO,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: true,
          savePercentage: 34,
        },
      },
      {
        name: "Reelty Pro+",
        type: "MONTHLY" as PlanType,
        price: 249,
        creditsPerInterval: 10,
        tierId: SubscriptionTierId.REELTY_PRO_PLUS,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: true,
          savePercentage: 34,
        },
      },
    ];

    for (const plan of plans) {
      const metadata: PlanMetadata = {
        features: Object.entries(plan.features)
          .filter(([_, value]) => value === true)
          .map(([key]) => key),
        maxListings: 10,
        maxPhotosPerListing: plan.features.maxPhotosPerListing,
        maxVideosPerMonth: plan.type === "MONTHLY" ? 30 : 10,
        customBranding: !plan.features.noWatermark,
        analytics: true,
        priority: plan.features.prioritySupport ? 1 : 2,
        premiumTemplatesEnabled: plan.features.premiumTemplates,
      };

      const credits = plan.creditsPerInterval || plan.credits || 0;
      const tierData: TierData = {
        tierId: plan.tierId,
        name: plan.name,
        description: `${
          plan.type === "MONTHLY" ? "Monthly subscription with " : ""
        }${credits} credit${credits > 1 ? "s" : ""}`,
        monthlyPrice: plan.price,
        planType: plan.type,
        creditsPerInterval: credits,
        features: metadata.features,
        maxPhotosPerListing: plan.features.maxPhotosPerListing,
        hasWatermark: !plan.features.noWatermark,
        maxReelDownloads: plan.features.unlimitedDownloads ? null : 10,
        maxActiveListings: metadata.maxListings,
        premiumTemplatesEnabled: metadata.premiumTemplatesEnabled,
      };

      await this.syncPlan(tierData, metadata);
    }
  }

  async handleSubscriptionStatusChange(
    userId: string,
    oldStatus: SubscriptionStatus,
    newStatus: SubscriptionStatus,
    oldTierId?: SubscriptionTierId,
    newTierId?: SubscriptionTierId
  ): Promise<void> {
    try {
      // Check if this is a transition from free/trial to paid
      const isUpgrade =
        (oldStatus === "INACTIVE" || oldStatus === "TRIALING") &&
        newStatus === "ACTIVE" &&
        oldTierId !== newTierId;

      // Check if the new tier has different watermark settings
      const [oldTier, newTier] = await Promise.all([
        oldTierId
          ? prisma.subscriptionTier.findFirst({
              where: { tierId: oldTierId },
            })
          : null,
        newTierId
          ? prisma.subscriptionTier.findFirst({
              where: { tierId: newTierId },
            })
          : null,
      ]);

      const watermarkChanged = oldTier?.hasWatermark !== newTier?.hasWatermark;

      // If this is an upgrade or watermark settings changed, reprocess videos
      if (isUpgrade || watermarkChanged) {
        await ProductionPipeline.reprocessUserVideos(userId);

        logger.info("Triggered video reprocessing due to subscription change", {
          userId,
          oldStatus,
          newStatus,
          oldTierId,
          newTierId,
          watermarkChanged,
          isUpgrade,
        });
      }
    } catch (error) {
      logger.error("Error handling subscription status change", {
        userId,
        oldStatus,
        newStatus,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }
}

export const plansService = new PlansService();
