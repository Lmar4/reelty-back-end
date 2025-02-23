/// <reference types="node" />
import {
  PrismaClient,
  AssetType,
  PlanType,
  SubscriptionTierId,
  SubscriptionStatus,
  UserRole,
} from "@prisma/client";
import { SUBSCRIPTION_TIERS } from "../src/constants/subscription-tiers.js";
import {
  reelTemplates,
  type TemplateKey,
  type ReelTemplate,
} from "../src/services/imageProcessing/templates/types.js";

const prisma = new PrismaClient();

// Helper type for our tier IDs
type TierId = keyof typeof SUBSCRIPTION_TIERS;

async function seedTemplates() {
  await prisma.template.deleteMany();

  // Convert reelTemplates to database format
  const templates = Object.entries(reelTemplates).map(
    ([key, template]: [string, ReelTemplate]) => ({
      name: template.name,
      description: template.description,
      key: key,
      tiers: getTiersForTemplate(key as TemplateKey),
      order: getTemplateOrder(key as TemplateKey),
      sequence: {
        sequence: template.sequence,
        durations: template.durations,
        reverseClips: template.reverseClips,
        music: template.music,
        transitions: template.transitions,
        colorCorrection: template.colorCorrection,
      },
      durations: template.durations,
      thumbnailUrl: null, // Will be populated later
    })
  );

  for (const template of templates) {
    // Get subscription tier IDs for the template's tiers
    const subscriptionTiers = await prisma.subscriptionTier.findMany({
      where: {
        tierId: {
          in: template.tiers as SubscriptionTierId[],
        },
      },
    });

    await prisma.template.create({
      data: {
        name: template.name,
        description: template.description,
        key: template.key,
        tiers: template.tiers,
        order: template.order,
        sequence: template.sequence,
        durations: template.durations,
        thumbnailUrl: template.thumbnailUrl,
        subscriptionTiers: {
          connect: subscriptionTiers.map((tier) => ({ id: tier.id })),
        },
      },
    });
  }

  console.log("Templates seeded successfully");
}

// Helper function to determine template tiers
function getTiersForTemplate(key: TemplateKey): SubscriptionTierId[] {
  switch (key) {
    case "googlezoomintro":
      return [
        SubscriptionTierId.FREE,
        SubscriptionTierId.REELTY,
        SubscriptionTierId.REELTY_PRO,
        SubscriptionTierId.REELTY_PRO_PLUS,
      ];
    case "crescendo":
    case "wave":
      return [
        SubscriptionTierId.REELTY,
        SubscriptionTierId.REELTY_PRO,
        SubscriptionTierId.REELTY_PRO_PLUS,
      ];
    case "storyteller":
    case "wesanderson":
    case "hyperpop":
      return [
        SubscriptionTierId.REELTY_PRO,
        SubscriptionTierId.REELTY_PRO_PLUS,
      ];
    default:
      return [SubscriptionTierId.REELTY_PRO_PLUS];
  }
}

// Helper function to determine template order
function getTemplateOrder(key: TemplateKey): number {
  const orderMap: Record<TemplateKey, number> = {
    googlezoomintro: 1,
    crescendo: 2,
    wave: 3,
    storyteller: 4,
    wesanderson: 5,
    hyperpop: 6,
  };
  return orderMap[key] || 99;
}

async function main() {
  console.log("Starting database seed...");

  // Create subscription tiers
  const tiers = [
    {
      tierId: SubscriptionTierId.FREE,
      name: "Free",
      description: "Basic access with limited features",
      stripePriceId: "price_free",
      stripeProductId: "prod_free",
      features: ["Basic templates", "Watermarked videos", "Community support"],
      monthlyPrice: 0,
      planType: PlanType.PAY_AS_YOU_GO,
      creditsPerInterval: 0,
      hasWatermark: true,
      maxPhotosPerListing: 10,
      maxReelDownloads: 3,
      maxActiveListings: 1,
      premiumTemplatesEnabled: false,
    },
    {
      tierId: SubscriptionTierId.REELTY,
      name: "Reelty",
      description: "Essential features with monthly subscription",
      stripePriceId: "price_reelty_monthly",
      stripeProductId: "prod_reelty",
      features: [
        "1 credit per month",
        "No watermark",
        "Email support",
        "Basic analytics",
      ],
      monthlyPrice: 39,
      planType: PlanType.MONTHLY,
      creditsPerInterval: 1,
      hasWatermark: false,
      maxPhotosPerListing: 20,
      maxReelDownloads: 10,
      maxActiveListings: 5,
      premiumTemplatesEnabled: false,
    },
    {
      tierId: SubscriptionTierId.REELTY_PRO,
      name: "Reelty Pro",
      description: "Advanced features for professionals",
      stripePriceId: "price_reelty_pro_monthly",
      stripeProductId: "prod_reelty_pro",
      features: [
        "4 credits per month",
        "Premium templates",
        "Priority support",
        "Advanced analytics",
      ],
      monthlyPrice: 129,
      planType: PlanType.MONTHLY,
      creditsPerInterval: 4,
      hasWatermark: false,
      maxPhotosPerListing: 30,
      maxReelDownloads: null,
      maxActiveListings: 15,
      premiumTemplatesEnabled: true,
    },
    {
      tierId: SubscriptionTierId.REELTY_PRO_PLUS,
      name: "Reelty Pro+",
      description: "Unlimited access with premium features",
      stripePriceId: "price_reelty_pro_plus_monthly",
      stripeProductId: "prod_reelty_pro_plus",
      features: [
        "10 credits per month",
        "All premium templates",
        "Priority support",
        "Advanced analytics",
        "Custom branding",
        "API access",
      ],
      monthlyPrice: 249,
      planType: PlanType.MONTHLY,
      creditsPerInterval: 10,
      hasWatermark: false,
      maxPhotosPerListing: -1,
      maxReelDownloads: null,
      maxActiveListings: -1,
      premiumTemplatesEnabled: true,
    },
  ];

  console.log("Seeding subscription tiers...");
  for (const tier of tiers) {
    await prisma.subscriptionTier.upsert({
      where: { tierId: tier.tierId },
      update: tier,
      create: tier,
    });
    console.log(`Created/updated subscription tier: ${tier.name}`);
  }

  // Create test users for each subscription tier
  const testUsers = [
    {
      id: "user_2siThAOP4AfhLAITRyB9lsy9hw5",
      email: "admin@reelty.app",
      password: "admin", // In production, this should be properly hashed
      firstName: "Admin",
      lastName: "User",
      currentTierId: SubscriptionTierId.REELTY_PRO_PLUS,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      role: UserRole.ADMIN,
    },
    {
      id: "user_free_test",
      email: "free@reelty.app",
      password: "test123",
      firstName: "Free",
      lastName: "User",
      currentTierId: SubscriptionTierId.FREE,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      role: UserRole.USER,
    },
    {
      id: "user_reelty_test",
      email: "reelty@reelty.app",
      password: "test123",
      firstName: "Reelty",
      lastName: "User",
      currentTierId: SubscriptionTierId.REELTY,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      role: UserRole.USER,
    },
    {
      id: "user_pro_test",
      email: "pro@reelty.app",
      password: "test123",
      firstName: "Pro",
      lastName: "User",
      currentTierId: SubscriptionTierId.REELTY_PRO,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      role: UserRole.USER,
    },
    {
      id: "user_proplus_test",
      email: "proplus@reelty.app",
      password: "test123",
      firstName: "Pro Plus",
      lastName: "User",
      currentTierId: SubscriptionTierId.REELTY_PRO_PLUS,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      role: UserRole.USER,
    },
  ];

  console.log("Creating test users...");
  for (const user of testUsers) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        currentTierId: user.currentTierId,
        subscriptionStatus: user.subscriptionStatus,
        role: user.role,
      },
      create: user,
    });
    console.log(`Created/updated user: ${user.email}`);
  }

  // Create templates
  await seedTemplates();

  // Create assets
  const assets = [
    // Music assets
    {
      name: "Crescendo",
      description: "Dynamic and progressive background music",
      filePath: "assets/music/crescendo.mp3",
      type: AssetType.MUSIC,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
    },
    {
      name: "Google Zoom Intro",
      description: "Dramatic intro music for location reveal",
      filePath: "assets/music/googlezoomintro.mp3",
      type: AssetType.MUSIC,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.FREE },
        })
      )?.id!,
      isActive: true,
      isDefault: true,
    },
    {
      name: "Hyperpop",
      description: "Energetic and modern background track",
      filePath: "assets/music/hyperpop.mp3",
      type: AssetType.MUSIC,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY_PRO },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
    },
    {
      name: "Storyteller",
      description: "Narrative-focused background music",
      filePath: "assets/music/storyteller.mp3",
      type: AssetType.MUSIC,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY_PRO },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
    },
    {
      name: "Wave",
      description: "Rhythmic and engaging background track",
      filePath: "assets/music/wave.mp3",
      type: AssetType.MUSIC,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
    },
    {
      name: "Wes Anderson",
      description: "Quirky and nostalgic background music",
      filePath: "assets/music/wesanderson.mp3",
      type: AssetType.MUSIC,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY_PRO },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
    },
    // Watermark assets
    {
      name: "Reelty Watermark",
      description: "Default Reelty watermark",
      filePath: "assets/watermark/reelty_watermark.png",
      type: AssetType.WATERMARK,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.FREE },
        })
      )?.id!,
      isActive: true,
      isDefault: true,
    },
    // Lottie assets
    {
      name: "Black Background Animation",
      description: "Lottie animation with black background",
      filePath: "assets/lottie/black-bg.lottie",
      type: AssetType.LOTTIE,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY_PRO },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
    },
    {
      name: "White Background Animation",
      description: "Lottie animation with white background",
      filePath: "assets/lottie/white-bg.lottie",
      type: AssetType.LOTTIE,
      subscriptionTierId: (
        await prisma.subscriptionTier.findUnique({
          where: { tierId: SubscriptionTierId.REELTY_PRO },
        })
      )?.id!,
      isActive: true,
      isDefault: false,
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
