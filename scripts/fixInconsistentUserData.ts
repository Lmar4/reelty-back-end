import {
  PrismaClient,
  SubscriptionTierId,
  SubscriptionStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

async function fixInconsistentUserData() {
  try {
    // Find users with paid tier subscriptions but non-ACTIVE status
    const inconsistentSubscriptions = await prisma.subscription.findMany({
      where: {
        tierId: {
          in: [
            SubscriptionTierId.REELTY,
            SubscriptionTierId.REELTY_PRO,
            SubscriptionTierId.REELTY_PRO_PLUS,
          ],
        },
        status: {
          notIn: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAST_DUE,
            SubscriptionStatus.CANCELED,
          ],
        },
      },
      include: {
        user: true,
      },
    });

    console.log(
      `Found ${inconsistentSubscriptions.length} inconsistent subscriptions`
    );

    // Fix inconsistent subscriptions
    for (const subscription of inconsistentSubscriptions) {
      console.log(
        `Fixing subscription for user ${subscription.user.email} with tier ${subscription.tierId} and status ${subscription.status}`
      );

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: subscription.userId,
          action: "STATUS_FIXED_BY_SCRIPT",
          stripeSubscriptionId:
            subscription.stripeSubscriptionId || "script_fix",
          status: SubscriptionStatus.ACTIVE,
        },
      });
    }

    // Find FREE tier subscriptions with ACTIVE status
    const freeActiveSubscriptions = await prisma.subscription.findMany({
      where: {
        tierId: SubscriptionTierId.FREE,
        status: SubscriptionStatus.ACTIVE,
      },
      include: {
        user: true,
      },
    });

    console.log(
      `Found ${freeActiveSubscriptions.length} FREE tier subscriptions with ACTIVE status`
    );

    // Fix FREE tier subscriptions with ACTIVE status
    for (const subscription of freeActiveSubscriptions) {
      console.log(
        `Fixing FREE tier subscription for user ${subscription.user.email} with ACTIVE status to INACTIVE`
      );

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.INACTIVE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: subscription.userId,
          action: "STATUS_FIXED_BY_SCRIPT",
          stripeSubscriptionId:
            subscription.stripeSubscriptionId || "script_fix",
          status: SubscriptionStatus.INACTIVE,
        },
      });
    }

    console.log("Data consistency check completed");
  } catch (error) {
    console.error("Error fixing inconsistent user data:", error);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  await fixInconsistentUserData();
  console.log("Script completed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
