import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { plansService } from "../services/stripe/plans.service.js";
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

    // Delete all subscription tiers from the database
    await prisma.subscriptionTier.deleteMany({});

    console.log("Cleanup completed successfully!");
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
}

async function main() {
  try {
    // First clean up existing plans
    await cleanupStripePlans();

    // Then create new plans
    await plansService.createPricingPlans();

    // Verify the plans were created correctly
    const activePlans = await stripe.products.list({
      active: true,
      expand: ["data.default_price"],
    });

    console.log("\nSuccessfully synchronized plans with Stripe!\n");
    console.log("Active Plans in Stripe:\n");

    for (const product of activePlans.data) {
      const price = product.default_price as Stripe.Price;
      console.log(`Plan: ${product.name}`);
      console.log(`- ID: ${product.id}`);
      console.log(`- Price: $${(price?.unit_amount || 0) / 100}`);
      console.log(`- Features: ${product.metadata.features}`);
      console.log("-------------------\n");
    }
  } catch (error) {
    console.error("Error synchronizing plans:", error);
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
