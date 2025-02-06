import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Create initial subscription tiers
  const tiers = [
    {
      id: "free",
      description: "Basic features for getting started",
      pricing: 0.0,
    },
    {
      id: "pro",
      description: "Advanced features for professionals",
      pricing: 29.99,
    },
    {
      id: "enterprise",
      description: "Custom solutions for large teams",
      pricing: 99.99,
    },
  ];

  console.log("Seeding subscription tiers...");
  for (const tier of tiers) {
    const existingTier = await prisma.subscriptionTier.findUnique({
      where: { id: tier.id },
    });

    if (!existingTier) {
      await prisma.subscriptionTier.create({
        data: tier,
      });
      console.log(`Created tier: ${tier.id}`);
    } else {
      console.log(`Tier ${tier.id} already exists`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
