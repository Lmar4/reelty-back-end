import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function addSubscription() {
  const prisma = new PrismaClient();

  try {
    console.log("Adding subscription for user...");

    // Create subscription
    const subscription = await prisma.subscription.create({
      data: {
        userId: "user_2txphAtnvJC6BDsUE7jSd6UmD4d",
        tierId: "b078709f-4cdd-4e11-8ab6-f750b69705dc", // REELTY_PRO_PLUS
        status: "ACTIVE",
        startDate: new Date(),
        startDateUtc: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        currentPeriodEndUtc: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        creditsBalance: 100,
        creditsPerPeriod: 100,
        version: 1,
      },
    });

    console.log("Subscription created:", subscription);

    // Update user with active subscription
    const updatedUser = await prisma.user.update({
      where: { id: "user_2txphAtnvJC6BDsUE7jSd6UmD4d" },
      data: {
        activeSubscriptionId: subscription.id,
      },
    });

    console.log("User updated with active subscription:", updatedUser);

    // Create listing credit
    const listingCredit = await prisma.listingCredit.create({
      data: {
        userId: "user_2txphAtnvJC6BDsUE7jSd6UmD4d",
        creditsRemaining: 100,
      },
    });

    console.log("Listing credit created:", listingCredit);

    // Create credit log
    const creditLog = await prisma.creditLog.create({
      data: {
        userId: "user_2txphAtnvJC6BDsUE7jSd6UmD4d",
        amount: 100,
        reason: "Initial credit (REELTY_PRO_PLUS)",
      },
    });

    console.log("Credit log created:", creditLog);
  } catch (error) {
    console.error("Error adding subscription:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
addSubscription()
  .then(() => console.log("Subscription added successfully"))
  .catch((error) => console.error("Failed to add subscription:", error));
