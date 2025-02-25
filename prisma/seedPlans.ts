import { PrismaClient, PlanType, SubscriptionTierId } from "@prisma/client";

const prisma = new PrismaClient();

async function seedPlans() {
  console.log("Starting plans seeding...");

  const tiers = [
    {
      tierId: SubscriptionTierId.FREE,
      name: "Free Trial",
      description: "Basic access with limited features",
      stripePriceId: "price_free",
      stripeProductId: "prod_free",
      features: ["Basic templates", "Watermarked videos", "Community support"],
      monthlyPrice: 0,
      planType: PlanType.PAY_AS_YOU_GO,
      creditsPerInterval: 1,
      hasWatermark: true,
      maxPhotosPerListing: 20,
      maxReelDownloads: 1,
      maxActiveListings: 1,
      premiumTemplatesEnabled: false,
    },
    // ... other tiers from your seed.ts
  ];

  console.log("Upserting subscription tiers...");
  for (const tier of tiers) {
    await prisma.subscriptionTier.upsert({
      where: { tierId: tier.tierId },
      update: tier,
      create: tier,
    });
    console.log(`Created/updated subscription tier: ${tier.name}`);
  }

  console.log("Plans seeding completed successfully!");
}

seedPlans()
  .catch((e) => {
    console.error("Error during plans seeding:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
