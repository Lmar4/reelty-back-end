import { PrismaClient } from "@prisma/client";
import { SUBSCRIPTION_TIERS } from "../src/constants/subscription-tiers";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting database reset and seed...");

  // Reset the database in the correct order
  console.log("Resetting database...");

  // Delete related records first
  await prisma.creditLog.deleteMany();
  await prisma.tierChange.deleteMany();
  await prisma.subscriptionLog.deleteMany();
  await prisma.listingCredit.deleteMany();
  await prisma.photo.deleteMany();
  await prisma.videoJob.deleteMany();
  await prisma.videoGenerationJob.deleteMany();
  await prisma.searchHistory.deleteMany();
  await prisma.errorLog.deleteMany();
  await prisma.tempUpload.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.asset.deleteMany();

  // Now we can safely delete users and subscription tiers
  await prisma.user.deleteMany();
  await prisma.template.deleteMany();
  await prisma.subscriptionTier.deleteMany();

  // Create subscription tiers
  console.log("Creating subscription tiers...");
  const tiers = [
    {
      id: SUBSCRIPTION_TIERS.BASIC,
      name: "Basic",
      description: "Essential features for getting started",
      stripePriceId: "price_basic_monthly",
      stripeProductId: "prod_basic",
      features: ["5 listings", "Basic templates", "Email support"],
      monthlyPrice: 0,
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
    },
    {
      id: SUBSCRIPTION_TIERS.ADMIN,
      name: "Admin",
      description: "Administrative access",
      stripePriceId: "price_admin",
      stripeProductId: "prod_admin",
      features: ["Full administrative access", "All features"],
      monthlyPrice: 0,
    },
  ];

  for (const tier of tiers) {
    await prisma.subscriptionTier.create({
      data: tier,
    });
    console.log(`Created subscription tier: ${tier.name}`);
  }

  // Create admin user
  console.log("Creating admin user...");
  const adminUser = await prisma.user.create({
    data: {
      id: "user_2slqwO8UeouJwKF3oOqyZQSxOuZ",
      email: "admin@reelty.app",
      password: "admin",
      firstName: "Admin",
      lastName: "User",
      currentTierId: SUBSCRIPTION_TIERS.ADMIN,
      subscriptionStatus: "ACTIVE",
      role: "ADMIN",
    },
  });

  console.log("Created admin user:", adminUser);

  // Create templates
  console.log("Creating templates...");
  const templates = [
    {
      name: "Google Zoom Intro",
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

  console.log("Database reset and seed completed successfully!");
}

main()
  .catch((e) => {
    console.error("Reset and seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
