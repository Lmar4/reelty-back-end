import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const prisma = new PrismaClient();

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is required");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
});

// Import subscription tier IDs
const SubscriptionTierId = {
  FREE: "FREE",
  REELTY: "REELTY",
  REELTY_PRO: "REELTY_PRO",
  REELTY_PRO_PLUS: "REELTY_PRO_PLUS",
};

// Import plan types
const PlanType = {
  MONTHLY: "MONTHLY",
  PAY_AS_YOU_GO: "PAY_AS_YOU_GO",
};

async function cleanupStripePlans() {
  try {
    console.log("Starting Stripe plans cleanup...");

    // Get all active products
    const products = await stripe.products.list({ active: true });

    // First deactivate all products (this automatically handles the default price issue)
    for (const product of products.data) {
      console.log(`Deactivating product: ${product.name} (${product.id})`);
      await stripe.products.update(product.id, { active: false });
    }

    // Then archive all prices
    for (const product of products.data) {
      console.log(
        `Archiving prices for product: ${product.name} (${product.id})`
      );
      const prices = await stripe.prices.list({ product: product.id });
      for (const price of prices.data) {
        if (price.active) {
          await stripe.prices.update(price.id, { active: false });
        }
      }
    }

    console.log("Cleanup completed successfully!");
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
}

async function syncPlan(tier, metadata) {
  try {
    if (!tier.name || !tier.description || !tier.tierId) {
      throw new Error("Name, description, and tierId are required");
    }

    // First, check if a tier with these Stripe IDs already exists
    const existingTier = await prisma.subscriptionTier.findFirst({
      where: {
        OR: [
          { tierId: tier.tierId },
          { name: tier.name },
          { stripeProductId: tier.stripeProductId },
          { stripePriceId: tier.stripePriceId },
        ],
      },
    });

    const stripeMetadata = {
      tierId: existingTier?.tierId || tier.tierId,
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
    let product;
    if (existingTier?.stripeProductId) {
      try {
        // Try to update the existing product
        product = await stripe.products.update(existingTier.stripeProductId, {
          name: tier.name,
          description: tier.description,
          metadata: stripeMetadata,
        });
      } catch (error) {
        // If the product doesn't exist in Stripe, create a new one
        if (error.code === "resource_missing") {
          console.log(
            `Product ${existingTier.stripeProductId} not found in Stripe, creating a new one`
          );
          product = await stripe.products.create({
            name: tier.name,
            description: tier.description,
            metadata: stripeMetadata,
          });
        } else {
          throw error;
        }
      }
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
      unit_amount: Math.round(tier.monthlyPrice * 100),
      currency: "usd",
      recurring:
        tier.planType === PlanType.MONTHLY ? { interval: "month" } : undefined,
      metadata: { tierId: existingTier?.tierId || tier.tierId },
    });

    // Archive old price if it exists
    if (existingTier?.stripePriceId) {
      try {
        await stripe.prices.update(existingTier.stripePriceId, {
          active: false,
        });
      } catch (error) {
        // Ignore errors if the price doesn't exist
        if (error.code !== "resource_missing") {
          console.warn(
            `Warning: Could not archive old price: ${error.message}`
          );
        }
      }
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
      monthlyPrice: tier.monthlyPrice,
      planType: tier.planType || PlanType.PAY_AS_YOU_GO,
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

async function createPricingPlans() {
  const plans = [
    // Free Trial Plan
    {
      name: "Free Trial",
      type: PlanType.PAY_AS_YOU_GO,
      price: 0,
      credits: 1,
      tierId: SubscriptionTierId.FREE,
      features: {
        maxPhotosPerListing: 5,
        unlimitedDownloads: false,
        noWatermark: false,
        premiumTemplates: false,
        prioritySupport: false,
      },
    },
    // Monthly Subscription Plans
    {
      name: "Reelty Basic",
      type: PlanType.MONTHLY,
      price: 49,
      creditsPerInterval: 2,
      tierId: SubscriptionTierId.REELTY,
      features: {
        maxPhotosPerListing: 10,
        unlimitedDownloads: false,
        noWatermark: false,
        premiumTemplates: false,
        prioritySupport: false,
      },
    },
    {
      name: "Reelty Pro",
      type: PlanType.MONTHLY,
      price: 99,
      creditsPerInterval: 5,
      tierId: SubscriptionTierId.REELTY_PRO,
      features: {
        maxPhotosPerListing: 15,
        unlimitedDownloads: true,
        noWatermark: true,
        premiumTemplates: true,
        prioritySupport: false,
      },
    },
    {
      name: "Reelty Pro+",
      type: PlanType.MONTHLY,
      price: 249,
      creditsPerInterval: 10,
      tierId: SubscriptionTierId.REELTY_PRO_PLUS,
      features: {
        maxPhotosPerListing: -1,
        unlimitedDownloads: true,
        noWatermark: true,
        premiumTemplates: true,
        prioritySupport: true,
      },
    },
    // Lifetime Access Plan
    {
      name: "Reelty Lifetime",
      type: PlanType.PAY_AS_YOU_GO,
      price: 249,
      credits: 24, // 2 listings per month for 12 months
      tierId: SubscriptionTierId.REELTY_PRO,
      features: {
        maxPhotosPerListing: 20,
        unlimitedDownloads: true,
        noWatermark: true,
        premiumTemplates: true,
        prioritySupport: true,
        maxReelsPerListing: 6,
        earlyAccess: true,
        referralProgram: true,
      },
    },
  ];

  for (const plan of plans) {
    try {
      console.log(`Processing plan: ${plan.name}`);

      const metadata = {
        features: Object.entries(plan.features)
          .filter(([key, value]) => value === true && key !== "maxDownloads")
          .map(([key]) => key),
        maxListings: plan.tierId === SubscriptionTierId.FREE ? 1 : 10,
        maxPhotosPerListing: plan.features.maxPhotosPerListing,
        maxVideosPerMonth: plan.type === PlanType.MONTHLY ? 30 : 10,
        customBranding: !plan.features.noWatermark,
        analytics: true,
        priority: plan.features.prioritySupport ? 1 : 2,
        premiumTemplatesEnabled: plan.features.premiumTemplates,
      };

      const credits = plan.creditsPerInterval || plan.credits || 0;
      const tierData = {
        tierId: plan.tierId,
        name: plan.name,
        description: `${
          plan.type === PlanType.MONTHLY ? "Monthly subscription with " : ""
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

      await syncPlan(tierData, metadata);
      console.log(`Successfully synced plan: ${plan.name}`);
    } catch (error) {
      console.error(`Error processing plan ${plan.name}:`, error.message);
      console.log("Continuing with next plan...");
    }
  }
}

async function main() {
  try {
    // First clean up existing plans
    await cleanupStripePlans();

    // Then create new plans
    await createPricingPlans();

    // Verify the plans were created correctly
    const activePlans = await stripe.products.list({
      active: true,
      expand: ["data.default_price"],
    });

    console.log("\nSuccessfully synchronized plans with Stripe!\n");
    console.log("Active Plans in Stripe:\n");

    for (const product of activePlans.data) {
      const price = product.default_price;
      console.log(`Plan: ${product.name}`);
      console.log(`- ID: ${product.id}`);
      console.log(`- Price: $${(price?.unit_amount || 0) / 100}`);
      console.log(`- Features: ${product.metadata.features}`);
      console.log("-------------------\n");
    }

    // Also show subscription tiers in the database
    const tiers = await prisma.subscriptionTier.findMany();
    console.log("\nSubscription tiers in database:\n");
    for (const tier of tiers) {
      console.log(`Tier: ${tier.name}`);
      console.log(`- ID: ${tier.id}`);
      console.log(`- Tier ID: ${tier.tierId}`);
      console.log(`- Stripe Product ID: ${tier.stripeProductId}`);
      console.log(`- Stripe Price ID: ${tier.stripePriceId}`);
      console.log("-------------------\n");
    }
  } catch (error) {
    console.error("Error synchronizing plans:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
