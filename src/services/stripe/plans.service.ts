import { PrismaClient, SubscriptionTier, Prisma } from "@prisma/client";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
});

const prisma = new PrismaClient();

export type PlanType = "PAY_AS_YOU_GO" | "MONTHLY";

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
}

export class PlansService {
  // Create or update a subscription plan
  async syncPlan(tier: TierData, metadata: PlanMetadata) {
    try {
      const stripeMetadata: Stripe.MetadataParam = {
        tierId: tier.id || "",
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

      if (!tier.name || !tier.description) {
        throw new Error("Name and description are required");
      }

      const productData: Stripe.ProductCreateParams = {
        name: tier.name,
        description: tier.description,
        metadata: stripeMetadata,
      };

      let product: Stripe.Product;

      if (tier.stripeProductId) {
        product = await stripe.products.update(
          tier.stripeProductId,
          productData
        );
      } else {
        product = await stripe.products.create(productData);
      }

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(tier.monthlyPrice! * 100),
        currency: "usd",
        recurring:
          tier.planType === "MONTHLY" ? { interval: "month" } : undefined,
        metadata: { tierId: tier.id || "" },
      });

      if (tier.stripePriceId) {
        await stripe.prices.update(tier.stripePriceId, { active: false });
      }

      const updateData: Prisma.SubscriptionTierUpdateInput = {
        stripeProductId: product.id,
        stripePriceId: price.id,
      };

      await prisma.subscriptionTier.update({
        where: { id: tier.id },
        data: updateData,
      });

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
        price: 49,
        credits: 1,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: false,
        },
      },
      {
        name: "2 Credits",
        type: "PAY_AS_YOU_GO" as PlanType,
        price: 79,
        credits: 2,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: false,
        },
      },
      {
        name: "5 Credits",
        type: "PAY_AS_YOU_GO" as PlanType,
        price: 189,
        credits: 5,
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
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: true,
          savePercentage: 20,
        },
      },
      {
        name: "Reelty Pro",
        type: "MONTHLY" as PlanType,
        price: 149,
        creditsPerInterval: 5,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: true,
          savePercentage: 20,
        },
      },
      {
        name: "Reelty Pro+",
        type: "MONTHLY" as PlanType,
        price: 299,
        creditsPerInterval: 12,
        features: {
          maxPhotosPerListing: 20,
          unlimitedDownloads: true,
          noWatermark: true,
          premiumTemplates: true,
          prioritySupport: true,
          savePercentage: 20,
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
}

export const plansService = new PlansService();
