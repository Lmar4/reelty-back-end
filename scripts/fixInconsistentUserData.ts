import {
  PrismaClient,
  SubscriptionTierId,
  SubscriptionStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

async function fixInconsistentUserData() {
  try {
    // Find users with paid tiers but non-ACTIVE status
    const inconsistentUsers = await prisma.user.findMany({
      where: {
        currentTierId: {
          in: [
            SubscriptionTierId.REELTY,
            SubscriptionTierId.REELTY_PRO,
            SubscriptionTierId.REELTY_PRO_PLUS,
          ],
        },
        subscriptionStatus: {
          notIn: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAST_DUE,
            SubscriptionStatus.CANCELED,
          ],
        },
      },
      select: {
        id: true,
        email: true,
        currentTierId: true,
        subscriptionStatus: true,
      },
    });

    console.log(
      `Found ${inconsistentUsers.length} users with inconsistent tier/status`
    );

    // Fix inconsistent users
    for (const user of inconsistentUsers) {
      console.log(
        `Fixing user ${user.email} with tier ${user.currentTierId} and status ${user.subscriptionStatus}`
      );

      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: SubscriptionStatus.ACTIVE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "STATUS_FIXED_BY_SCRIPT",
          stripeSubscriptionId: "data_fix",
          status: SubscriptionStatus.ACTIVE,
        },
      });
    }

    return inconsistentUsers;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  try {
    console.log("Starting user data fix...");
    const fixedUsers = await fixInconsistentUserData();
    console.log(`Fix complete. Updated ${fixedUsers.length} users.`);
  } catch (error) {
    console.error("Error during fix:", error);
  }
}

main();
