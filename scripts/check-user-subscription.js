import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function checkUserSubscription() {
  const prisma = new PrismaClient();

  try {
    console.log("Checking user subscription...");

    const user = await prisma.user.findUnique({
      where: { id: "user_2uC2Psx4KWyYtFeWOuGg7FohB3t" },
      include: {
        subscriptions: true,
      },
    });

    if (user) {
      console.log("User:", user.email);
      console.log("Active Subscription ID:", user.activeSubscriptionId);
      console.log("Subscriptions:", user.subscriptions);

      // Get the active subscription details
      if (user.activeSubscriptionId) {
        const activeSubscription = await prisma.subscription.findUnique({
          where: { id: user.activeSubscriptionId },
          include: {
            tier: true,
          },
        });

        console.log("Active Subscription Details:", {
          id: activeSubscription.id,
          status: activeSubscription.status,
          tier: activeSubscription.tier
            ? {
                id: activeSubscription.tier.id,
                tierId: activeSubscription.tier.tierId,
                name: activeSubscription.tier.name,
              }
            : null,
        });
      }

      // Get listing credits
      const listingCredits = await prisma.listingCredit.findMany({
        where: { userId: user.id },
      });

      console.log("Listing Credits:", listingCredits);

      // Get credit logs
      const creditLogs = await prisma.creditLog.findMany({
        where: { userId: user.id },
      });

      console.log("Credit Logs:", creditLogs);
    } else {
      console.log("User not found");
    }
  } catch (error) {
    console.error("Error checking user subscription:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
checkUserSubscription()
  .then(() => console.log("Check completed"))
  .catch((error) => console.error("Check failed:", error));
