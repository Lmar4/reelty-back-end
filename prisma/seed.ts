/// <reference types="node" />
import { PrismaClient, AssetType, PlanType } from "@prisma/client";
import { SUBSCRIPTION_TIERS } from "../src/constants/subscription-tiers";

const prisma = new PrismaClient();

async function seedTemplates() {
  await prisma.template.deleteMany();

  const templates = [
    {
      name: "googlezoomintro",
      description:
        "Start with a dramatic Google Maps zoom into the property location, followed by property highlights",
      tiers: ["free", "pro", "enterprise", "admin"],
      order: 1,
    },
    {
      name: "Crescendo",
      description:
        "A dynamic template that builds momentum with progressively longer clips",
      tiers: ["pro", "enterprise", "admin"],
      order: 2,
    },
    {
      name: "Wave",
      description:
        "An engaging rhythm that alternates between quick glimpses and lingering views",
      tiers: ["pro", "enterprise", "admin"],
      order: 3,
    },
    {
      name: "Storyteller",
      description:
        "A narrative-driven template that guides viewers through the property story",
      tiers: ["enterprise", "admin"],
      order: 4,
    },
  ];

  for (const template of templates) {
    // Get subscription tier IDs for the template's tiers
    const subscriptionTiers = await prisma.subscriptionTier.findMany({
      where: {
        name: {
          in: template.tiers.map((tier) => tier.toUpperCase()),
        },
      },
    });

    await prisma.template.create({
      data: {
        ...template,
        subscriptionTiers: {
          connect: subscriptionTiers.map((tier) => ({ id: tier.id })),
        },
      },
    });
  }

  console.log("Templates seeded successfully");
}

async function main() {
  console.log("Starting database seed...");

  // Create subscription tiers
  const tiers = [
    {
      id: SUBSCRIPTION_TIERS.BASIC,
      name: "Basic",
      description: "Essential features for getting started",
      stripePriceId: "price_basic_monthly",
      stripeProductId: "prod_basic",
      features: ["5 listings", "Basic templates", "Email support"],
      monthlyPrice: 0,
      planType: PlanType.PAY_AS_YOU_GO,
      creditsPerInterval: 5,
      hasWatermark: true,
      maxPhotosPerListing: 10,
      maxReelDownloads: 5,
      maxActiveListings: 5,
      premiumTemplatesEnabled: false,
      metadata: {},
    },
    {
      id: SUBSCRIPTION_TIERS.PRO,
      name: "Professional",
      description: "Advanced features for real estate professionals",
      stripePriceId: "price_pro_monthly",
      stripeProductId: "prod_pro",
      features: [
        "20 listings",
        "Pro templates",
        "Priority support",
        "Analytics",
      ],
      monthlyPrice: 29.99,
      planType: PlanType.MONTHLY,
      creditsPerInterval: 20,
      hasWatermark: false,
      maxPhotosPerListing: 20,
      maxReelDownloads: 20,
      maxActiveListings: 20,
      premiumTemplatesEnabled: true,
      metadata: {},
    },
    {
      id: SUBSCRIPTION_TIERS.ENTERPRISE,
      name: "Enterprise",
      description: "Custom solutions for large teams",
      stripePriceId: "price_enterprise_monthly",
      stripeProductId: "prod_enterprise",
      features: [
        "Unlimited listings",
        "Custom templates",
        "Dedicated support",
        "API access",
      ],
      monthlyPrice: 99.99,
      planType: PlanType.MONTHLY,
      creditsPerInterval: 100,
      hasWatermark: false,
      maxPhotosPerListing: 50,
      maxReelDownloads: null,
      maxActiveListings: 100,
      premiumTemplatesEnabled: true,
      metadata: {},
    },
    {
      id: SUBSCRIPTION_TIERS.ADMIN,
      name: "Admin",
      description: "Administrative access",
      stripePriceId: "price_admin",
      stripeProductId: "prod_admin",
      features: ["Full administrative access", "All features"],
      monthlyPrice: 0,
      planType: PlanType.MONTHLY,
      creditsPerInterval: -1,
      hasWatermark: false,
      maxPhotosPerListing: -1,
      maxReelDownloads: null,
      maxActiveListings: -1,
      premiumTemplatesEnabled: true,
      metadata: {},
    },
  ];

  console.log("Seeding subscription tiers...");
  for (const tier of tiers) {
    await prisma.subscriptionTier.upsert({
      where: { id: tier.id },
      update: tier,
      create: tier,
    });
    console.log(`Created/updated subscription tier: ${tier.name}`);
  }

  // Create or update admin user
  const existingAdmin = await prisma.user.findFirst({
    where: {
      OR: [
        { id: "user_2slqwO8UeouJwKF3oOqyZQSxOuZ" },
        { email: "admin@reelty.app" },
      ],
    },
  });

  const adminUser = existingAdmin
    ? await prisma.user.update({
        where: { id: existingAdmin.id },
        data: {
          currentTierId: SUBSCRIPTION_TIERS.ADMIN,
          subscriptionStatus: "ACTIVE",
        },
      })
    : await prisma.user.create({
        data: {
          id: "user_2siThAOP4AfhLAITRyB9lsy9hw5",
          email: "admin@reelty.app",
          password: "admin", // In production, this should be properly hashed
          firstName: "Admin",
          lastName: "User",
          currentTierId: SUBSCRIPTION_TIERS.ADMIN,
          subscriptionStatus: "ACTIVE",
        },
      });

  console.log("Created/updated admin user:", adminUser);

  // Create test user with specific ID
  const testUser = await prisma.user.upsert({
    where: { id: "user_2slqwO8UeouJwKF3oOqyZQSxOuZ" },
    update: {
      currentTierId: SUBSCRIPTION_TIERS.PRO,
      subscriptionStatus: "ACTIVE",
    },
    create: {
      id: "user_2slqwO8UeouJwKF3oOqyZQSxOuZ",
      email: "test@reelty.app",
      password: "test123", // In production, this should be properly hashed
      firstName: "Test",
      lastName: "User",
      currentTierId: SUBSCRIPTION_TIERS.PRO,
      subscriptionStatus: "ACTIVE",
      role: "USER",
    },
  });

  console.log("Created/updated test user:", testUser);

  // Create templates
  await seedTemplates();

  // Create assets
  const assets = [
    {
      name: "Smooth Jazz",
      description: "Relaxing background music",
      filePath: "/assets/music/smooth.mp3",
      type: AssetType.MUSIC,
      subscriptionTier: SUBSCRIPTION_TIERS.BASIC,
      isActive: true,
    },
    {
      name: "Premium Watermark",
      description: "Professional watermark overlay",
      filePath: "/assets/watermarks/premium.png",
      type: AssetType.WATERMARK,
      subscriptionTier: SUBSCRIPTION_TIERS.PRO,
      isActive: true,
    },
  ];

  console.log("Seeding assets...");
  for (const asset of assets) {
    const created = await prisma.asset.create({
      data: asset,
    });
    console.log(`Created asset: ${created.name}`);
  }

  console.log("Seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("Error during seeding:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
