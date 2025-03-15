// Fix Stripe Plans Script
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

async function main() {
  try {
    console.log("Starting to fix Stripe plans...");

    // First, let's create the products and prices in Stripe
    const plans = [
      {
        name: "Free Trial",
        description: "Basic access with limited features",
        price: 0,
        features: [
          "Basic templates",
          "Watermarked videos",
          "Community support",
        ],
        tierId: "FREE",
      },
      {
        name: "Reelty",
        description: "Essential features with monthly subscription",
        price: 39,
        features: [
          "1 credit per month",
          "No watermark",
          "Email support",
          "Basic analytics",
        ],
        tierId: "REELTY",
      },
      {
        name: "Reelty Pro",
        description: "Advanced features for professionals",
        price: 129,
        features: [
          "4 credits per month",
          "Premium templates",
          "Priority support",
          "Advanced analytics",
        ],
        tierId: "REELTY_PRO",
      },
      {
        name: "Reelty Pro+",
        description: "Unlimited access with premium features",
        price: 249,
        features: [
          "10 credits per month",
          "All premium templates",
          "Priority support",
          "Advanced analytics",
          "Custom branding",
          "API access",
        ],
        tierId: "REELTY_PRO_PLUS",
      },
    ];

    // Create products and prices in Stripe
    for (const plan of plans) {
      console.log(`Creating/updating plan: ${plan.name}`);

      // Create product
      const product = await stripe.products.create({
        name: plan.name,
        description: plan.description,
        metadata: {
          tierId: plan.tierId,
          features: JSON.stringify(plan.features),
        },
      });

      // Create price
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.price * 100,
        currency: "usd",
        recurring: plan.price > 0 ? { interval: "month" } : undefined,
        metadata: { tierId: plan.tierId },
      });

      // Update product with default price
      await stripe.products.update(product.id, {
        default_price: price.id,
      });

      // Update the subscription tier in the database
      await prisma.subscriptionTier.updateMany({
        where: { tierId: plan.tierId },
        data: {
          stripeProductId: product.id,
          stripePriceId: price.id,
        },
      });

      console.log(
        `Updated plan ${plan.name} with product ID ${product.id} and price ID ${price.id}`
      );
    }

    console.log("Successfully fixed Stripe plans!");

    // Verify the plans were created correctly
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
    console.error("Error fixing Stripe plans:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
