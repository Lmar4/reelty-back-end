/// <reference types="node" />
import { PrismaClient, AssetType } from "@prisma/client";

const prisma = new PrismaClient();

// Generate UUIDs for tiers
const TIER_BASIC_ID = "550e8400-e29b-41d4-a716-446655440000";
const TIER_PRO_ID = "550e8400-e29b-41d4-a716-446655440001";
const TIER_ENTERPRISE_ID = "550e8400-e29b-41d4-a716-446655440002";
const TIER_ADMIN_ID = "550e8400-e29b-41d4-a716-446655440003";

async function main() {
  console.log("Starting database seed...");

  // Create subscription tiers
  const tiers = [
    {
      id: TIER_BASIC_ID,
      name: "Basic",
      description: "Essential features for getting started",
      stripePriceId: "price_basic_monthly",
      stripeProductId: "prod_basic",
      features: ["5 listings", "Basic templates", "Email support"],
      monthlyPrice: 0,
    },
    {
      id: TIER_PRO_ID,
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
    },
    {
      id: TIER_ENTERPRISE_ID,
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
    },
    {
      id: TIER_ADMIN_ID,
      name: "Admin",
      description: "Administrative access",
      stripePriceId: "price_admin",
      stripeProductId: "prod_admin",
      features: ["Full administrative access", "All features"],
      monthlyPrice: 0,
    },
  ];

  console.log("Seeding subscription tiers...");
  for (const tier of tiers) {
    await prisma.subscriptionTier.upsert({
      where: { id: tier.id },
      update: tier,
      create: tier,
    });
    console.log(`Created/updated subscription tier: ${tier.id}`);
  }

  // Create admin user
  console.log("Creating admin user...");
  const adminUser = await prisma.user.upsert({
    where: { id: "user_2siThAOP4AfhLAITRyB9lsy9hw5" },
    update: {
      email: "admin@reelty.com",
      firstName: "Admin",
      lastName: "User",
      password: "$2b$10$dGQI7Ut8.M/BzMgvx5Y8UOEFVtD9yvD3FIp0Fs9RDvWRvYXGw3bLG",
      currentTierId: TIER_ADMIN_ID,
      subscriptionStatus: "active",
    },
    create: {
      id: "user_2siThAOP4AfhLAITRyB9lsy9hw5",
      email: "admin@reelty.com",
      firstName: "Admin",
      lastName: "User",
      password: "$2b$10$dGQI7Ut8.M/BzMgvx5Y8UOEFVtD9yvD3FIp0Fs9RDvWRvYXGw3bLG",
      currentTierId: TIER_ADMIN_ID,
      subscriptionStatus: "active",
    },
  });
  console.log(`Created/updated admin user: ${adminUser.email}`);

  // Create templates
  const templates = [
    {
      name: "Modern Minimal",
      description: "Clean and modern template for luxury properties",
      sequence: { transitions: ["fade", "slide"], effects: ["zoom", "pan"] },
      durations: { intro: 2, main: 15, outro: 3 },
      musicPath: "/assets/music/minimal.mp3",
      musicVolume: 0.8,
      subscriptionTier: TIER_BASIC_ID,
      isActive: true,
    },
    {
      name: "Dynamic Pro",
      description: "Professional template with dynamic transitions",
      sequence: {
        transitions: ["dissolve", "wipe"],
        effects: ["blur", "rotate"],
      },
      durations: { intro: 3, main: 20, outro: 4 },
      musicPath: "/assets/music/upbeat.mp3",
      musicVolume: 0.9,
      subscriptionTier: TIER_PRO_ID,
      isActive: true,
    },
  ];

  console.log("Seeding templates...");
  for (const template of templates) {
    const created = await prisma.template.create({
      data: template,
    });
    console.log(`Created template: ${created.name}`);
  }

  // Create assets
  const assets = [
    {
      name: "Smooth Jazz",
      description: "Relaxing background music",
      filePath: "/assets/music/smooth.mp3",
      type: AssetType.MUSIC,
      subscriptionTier: TIER_BASIC_ID,
      isActive: true,
    },
    {
      name: "Premium Watermark",
      description: "Professional watermark overlay",
      filePath: "/assets/watermarks/premium.png",
      type: AssetType.WATERMARK,
      subscriptionTier: TIER_PRO_ID,
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
