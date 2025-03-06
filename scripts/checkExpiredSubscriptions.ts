import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
} from "@prisma/client";
import { logger } from "../src/utils/logger.js";

const prisma = new PrismaClient();

/**
 * Checks for users with canceled subscriptions that have passed their period end date
 * and downgrades them to the FREE tier
 */
async function checkExpiredSubscriptions() {
  try {
    logger.info("Starting expired subscription check");

    // Find users with CANCELED status and expired period end date
    const expiredUsers = await prisma.user.findMany({
      where: {
        subscriptionStatus: "CANCELED",
        subscriptionPeriodEnd: {
          lt: new Date(), // Less than current date
        },
        currentTierId: {
          not: SubscriptionTierId.FREE,
        },
        // Ensure currentTierId is not null
        NOT: {
          currentTierId: null,
        },
      },
      select: {
        id: true,
        email: true,
        currentTierId: true,
        subscriptionPeriodEnd: true,
      },
    });

    logger.info(
      `Found ${expiredUsers.length} users with expired subscriptions`
    );

    // Process each expired user
    for (const user of expiredUsers) {
      logger.info(`Downgrading user ${user.email} to FREE tier`, {
        userId: user.id,
        oldTier: user.currentTierId,
        periodEnd: user.subscriptionPeriodEnd,
      });

      // Update user to FREE tier and INACTIVE status
      await prisma.user.update({
        where: { id: user.id },
        data: {
          currentTierId: SubscriptionTierId.FREE,
          subscriptionStatus: "INACTIVE",
        },
      });

      // Log the tier change
      await prisma.tierChange.create({
        data: {
          userId: user.id,
          oldTier: user.currentTierId as string,
          newTier: SubscriptionTierId.FREE,
          reason: "Subscription period ended (scheduled job)",
        },
      });

      // Log the subscription change
      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "DOWNGRADED_TO_FREE_SCHEDULED",
          stripeSubscriptionId: "scheduled_job",
          status: "INACTIVE",
        },
      });
    }

    logger.info("Completed expired subscription check");
    return expiredUsers.length;
  } catch (error) {
    logger.error("Error checking expired subscriptions", { error });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the check
checkExpiredSubscriptions()
  .then((count) => {
    logger.info(`Processed ${count} expired subscriptions`);
    process.exit(0);
  })
  .catch((error) => {
    logger.error("Error checking expired subscriptions", { error });
    process.exit(1);
  });

// For manual testing or one-time runs
export { checkExpiredSubscriptions };
