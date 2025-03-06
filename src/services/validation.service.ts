import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
} from "@prisma/client";
import { logger } from "../utils/logger.js";

const prisma = new PrismaClient();

/**
 * Validates user data to ensure consistency between subscription tiers and statuses
 * @returns Array of fixed users
 */
export async function validateUserData() {
  try {
    logger.info("Starting user data validation");

    // Find users with paid tiers but non-ACTIVE status (excluding CANCELED and PAST_DUE which are valid)
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

    logger.info(
      `Found ${inconsistentUsers.length} users with inconsistent tier/status`
    );

    // Fix inconsistent users
    for (const user of inconsistentUsers) {
      logger.info(
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
          action: "STATUS_FIXED_BY_VALIDATION",
          stripeSubscriptionId: "validation_fix",
          status: SubscriptionStatus.ACTIVE,
        },
      });
    }

    // Find users with FREE tier but ACTIVE status
    const freeActiveUsers = await prisma.user.findMany({
      where: {
        currentTierId: SubscriptionTierId.FREE,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
      select: {
        id: true,
        email: true,
        currentTierId: true,
        subscriptionStatus: true,
      },
    });

    logger.info(
      `Found ${freeActiveUsers.length} FREE tier users with ACTIVE status`
    );

    // Fix FREE tier users with ACTIVE status
    for (const user of freeActiveUsers) {
      logger.info(
        `Fixing FREE tier user ${user.email} with ACTIVE status to INACTIVE`
      );

      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: SubscriptionStatus.INACTIVE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "STATUS_FIXED_BY_VALIDATION",
          stripeSubscriptionId: "validation_fix",
          status: SubscriptionStatus.INACTIVE,
        },
      });
    }

    // Find users with null tier but non-INACTIVE status
    const nullTierUsers = await prisma.user.findMany({
      where: {
        currentTierId: null,
        subscriptionStatus: {
          not: SubscriptionStatus.INACTIVE,
        },
      },
      select: {
        id: true,
        email: true,
        subscriptionStatus: true,
      },
    });

    logger.info(
      `Found ${nullTierUsers.length} users with null tier but non-INACTIVE status`
    );

    // Fix users with null tier but non-INACTIVE status
    for (const user of nullTierUsers) {
      logger.info(
        `Fixing user ${user.email} with null tier and ${user.subscriptionStatus} status`
      );

      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: SubscriptionStatus.INACTIVE,
          currentTierId: SubscriptionTierId.FREE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "STATUS_AND_TIER_FIXED_BY_VALIDATION",
          stripeSubscriptionId: "validation_fix",
          status: SubscriptionStatus.INACTIVE,
        },
      });

      await prisma.tierChange.create({
        data: {
          userId: user.id,
          oldTier: SubscriptionTierId.FREE, // Default since we don't know the old tier
          newTier: SubscriptionTierId.FREE,
          reason: "Fixed null tier by validation",
        },
      });
    }

    const totalFixed =
      inconsistentUsers.length + freeActiveUsers.length + nullTierUsers.length;
    logger.info(`Validation complete. Fixed ${totalFixed} users.`);

    return {
      inconsistentUsers,
      freeActiveUsers,
      nullTierUsers,
      totalFixed,
    };
  } catch (error) {
    logger.error("Error during validation:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}
