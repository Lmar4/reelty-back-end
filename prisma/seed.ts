import { PrismaClient, AssetType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting database seed...");

  // Create subscription tiers
  const tiers = [
    {
      id: "tier_basic",
      name: "Basic",
      description: "Essential features for getting started",
      stripePriceId: "price_basic_monthly",
      stripeProductId: "prod_basic",
      features: ["5 listings", "Basic templates", "Email support"],
      monthlyPrice: 0.0,
    },
    {
      id: "tier_pro",
      name: "Professional",
      description: "Advanced features for real estate professionals",
      stripePriceId: "price_pro_monthly",
      stripeProductId: "prod_pro",
      features: ["20 listings", "Pro templates", "Priority support", "Analytics"],
      monthlyPrice: 29.99,
    },
    {
      id: "tier_enterprise",
      name: "Enterprise",
      description: "Custom solutions for large teams",
      stripePriceId: "price_enterprise_monthly",
      stripeProductId: "prod_enterprise",
      features: ["Unlimited listings", "Custom templates", "Dedicated support", "API access"],
      monthlyPrice: 99.99,
    },
  ];

  console.log("Seeding subscription tiers...");
  for (const tier of tiers) {
    const existingTier = await prisma.subscriptionTier.upsert({
      where: { id: tier.id },
      update: tier,
      create: tier,
    });
    console.log(`Upserted tier: ${existingTier.name}`);
  }

  // Create templates
  const templates = [
    {
      name: "Modern Minimal",
      description: "Clean and modern template for luxury properties",
      sequence: { transitions: ["fade", "slide"], effects: ["zoom", "pan"] },
      durations: { intro: 2, main: 15, outro: 3 },
      musicPath: "/assets/music/minimal.mp3",
      musicVolume: 0.8,
      subscriptionTier: "tier_basic",
      isActive: true,
    },
    {
      name: "Dynamic Pro",
      description: "Professional template with dynamic transitions",
      sequence: { transitions: ["dissolve", "wipe"], effects: ["blur", "rotate"] },
      durations: { intro: 3, main: 20, outro: 4 },
      musicPath: "/assets/music/upbeat.mp3",
      musicVolume: 0.9,
      subscriptionTier: "tier_pro",
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
      subscriptionTier: "tier_basic",
      isActive: true,
    },
    {
      name: "Premium Watermark",
      description: "Professional watermark overlay",
      filePath: "/assets/watermarks/premium.png",
      type: AssetType.WATERMARK,
      subscriptionTier: "tier_pro",
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

  // Create a test user
  const user = await prisma.user.create({
    data: {
      email: "test@example.com",
      password: "$2b$10$dGQI7Ut8.M/BzMgvx5Y8UOEFVtD9yvD3FIp0Fs9RDvWRvYXGw3bLG", // hashed "password123"
      firstName: "Test",
      lastName: "User",
      stripeCustomerId: "cus_test123",
      currentTierId: "tier_basic",
      subscriptionStatus: "active",
    },
  });
  console.log(`Created test user: ${user.email}`);

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
