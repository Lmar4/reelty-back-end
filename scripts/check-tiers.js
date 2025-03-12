import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function checkTiers() {
  const prisma = new PrismaClient();

  try {
    console.log("Checking subscription tiers...");

    const tiers = await prisma.subscriptionTier.findMany();

    console.log("Subscription tiers:");
    tiers.forEach((tier) => {
      console.log(
        `- ID: ${tier.id}, TierID: ${tier.tierId}, Name: ${tier.name}`
      );
    });
  } catch (error) {
    console.error("Error checking tiers:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
checkTiers()
  .then(() => console.log("Check completed"))
  .catch((error) => console.error("Check failed:", error));
