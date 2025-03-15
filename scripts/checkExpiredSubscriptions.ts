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

    // Find subscriptions with CANCELED status and expired period end date
    const expiredSubscriptions = await prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.CANCELED,
        currentPeriodEnd: {
          lt: new Date(), // Less than current date
        },
        tierId: {
          not: SubscriptionTierId.FREE,
        },
      },
      include: {
        user: true,
      },
    });

    logger.info(
      `Found ${expiredSubscriptions.length} subscriptions with expired period end`
    );

    // Get the FREE tier
    const freeTier = await prisma.subscriptionTier.findUnique({
      where: { tierId: SubscriptionTierId.FREE },
    });

    if (!freeTier) {
      throw new Error("FREE tier not found in database");
    }

    // Process each expired subscription
    for (const subscription of expiredSubscriptions) {
      logger.info(`Downgrading user ${subscription.user.email} to FREE tier`, {
        userId: subscription.userId,
        oldTier: subscription.tierId,
        periodEnd: subscription.currentPeriodEnd,
      });

      // Update the subscription to FREE tier
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          tierId: freeTier.id,
          status: SubscriptionStatus.INACTIVE,
        },
      });

      // Log the tier change
      await prisma.tierChange.create({
        data: {
          userId: subscription.userId,
          oldTier: subscription.tierId,
          newTier: SubscriptionTierId.FREE,
          reason: "Subscription expired",
        },
      });

      // Log the subscription change
      await prisma.subscriptionLog.create({
        data: {
          userId: subscription.userId,
          action: "SUBSCRIPTION_EXPIRED",
          stripeSubscriptionId: subscription.stripeSubscriptionId || "expired",
          status: SubscriptionStatus.INACTIVE,
        },
      });
    }

    logger.info("Expired subscription check completed");
  } catch (error) {
    logger.error("Error checking expired subscriptions:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
checkExpiredSubscriptions();
