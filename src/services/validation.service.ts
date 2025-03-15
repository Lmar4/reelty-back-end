import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
  PlanType,
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
        subscriptions: {
          some: {
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
        },
      },
      include: {
        subscriptions: {
          where: {
            status: {
              not: SubscriptionStatus.INACTIVE,
            },
          },
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    logger.info(
      `Found ${inconsistentUsers.length} users with inconsistent tier/status`
    );

    // Fix inconsistent users
    for (const user of inconsistentUsers) {
      const subscription = user.subscriptions[0];
      if (!subscription) continue;

      logger.info(
        `Fixing user ${user.email} with tier ${subscription.tierId} and status ${subscription.status}`
      );

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "STATUS_FIXED_BY_VALIDATION",
          stripeSubscriptionId:
            subscription.stripeSubscriptionId || "validation_fix",
          status: SubscriptionStatus.ACTIVE,
        },
      });
    }

    // Find users with FREE tier but ACTIVE status
    const freeActiveUsers = await prisma.user.findMany({
      where: {
        subscriptions: {
          some: {
            tierId: SubscriptionTierId.FREE,
            status: SubscriptionStatus.ACTIVE,
          },
        },
      },
      include: {
        subscriptions: {
          where: {
            tierId: SubscriptionTierId.FREE,
            status: SubscriptionStatus.ACTIVE,
          },
          take: 1,
        },
      },
    });

    logger.info(
      `Found ${freeActiveUsers.length} FREE tier users with ACTIVE status`
    );

    // Fix FREE tier users with ACTIVE status
    for (const user of freeActiveUsers) {
      const subscription = user.subscriptions[0];
      if (!subscription) continue;

      logger.info(
        `Fixing FREE tier user ${user.email} with ACTIVE status to INACTIVE`
      );

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.INACTIVE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "STATUS_FIXED_BY_VALIDATION",
          stripeSubscriptionId:
            subscription.stripeSubscriptionId || "validation_fix",
          status: SubscriptionStatus.INACTIVE,
        },
      });
    }

    // Find users with no active subscription but with non-INACTIVE status subscriptions
    const nullTierUsers = await prisma.user.findMany({
      where: {
        subscriptions: {
          none: {
            status: SubscriptionStatus.ACTIVE,
          },
          some: {
            status: {
              not: SubscriptionStatus.INACTIVE,
            },
          },
        },
      },
      include: {
        subscriptions: {
          where: {
            status: {
              not: SubscriptionStatus.INACTIVE,
            },
          },
          take: 1,
        },
      },
    });

    logger.info(
      `Found ${nullTierUsers.length} users with no active subscription but non-INACTIVE status`
    );

    // Fix users with null tier but non-INACTIVE status
    for (const user of nullTierUsers) {
      const subscription = user.subscriptions[0];
      if (!subscription) continue;

      logger.info(
        `Fixing user ${user.email} with no active subscription and ${subscription.status} status`
      );

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.INACTIVE,
          tierId: SubscriptionTierId.FREE,
        },
      });

      await prisma.subscriptionLog.create({
        data: {
          userId: user.id,
          action: "STATUS_AND_TIER_FIXED_BY_VALIDATION",
          stripeSubscriptionId:
            subscription.stripeSubscriptionId || "validation_fix",
          status: SubscriptionStatus.INACTIVE,
        },
      });

      await prisma.tierChange.create({
        data: {
          userId: user.id,
          oldTier: subscription.tierId || SubscriptionTierId.FREE,
          newTier: SubscriptionTierId.FREE,
          reason: "Fixed null tier by validation",
        },
      });
    }

    // Validate subscription tiers to ensure they have proper plan types
    const tiersWithoutPlanType = await prisma.subscriptionTier.findMany({
      where: {
        planType: undefined,
      },
    });

    logger.info(`Found ${tiersWithoutPlanType.length} tiers without plan type`);

    for (const tier of tiersWithoutPlanType) {
      // Determine plan type based on tier properties
      let planType: PlanType = PlanType.MONTHLY;

      if (tier.creditsPerInterval > 0 && tier.monthlyPriceCents === 0) {
        planType = PlanType.MONTHLY; // Default to MONTHLY since FREE doesn't exist
      } else if (tier.tierId === SubscriptionTierId.FREE) {
        planType = PlanType.MONTHLY; // Default to MONTHLY since FREE doesn't exist
      } else if (tier.name.toLowerCase().includes("pay as you go")) {
        planType = PlanType.PAY_AS_YOU_GO;
      }

      await prisma.subscriptionTier.update({
        where: { id: tier.id },
        data: { planType },
      });

      logger.info(`Updated tier ${tier.name} with plan type ${planType}`);
    }

    const totalFixed =
      inconsistentUsers.length +
      freeActiveUsers.length +
      nullTierUsers.length +
      tiersWithoutPlanType.length;

    logger.info(`Validation complete. Fixed ${totalFixed} issues.`);

    return {
      inconsistentUsers,
      freeActiveUsers,
      nullTierUsers,
      tiersWithoutPlanType,
      totalFixed,
    };
  } catch (error) {
    logger.error("Error during validation:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Validates subscription tier data to ensure consistency
 */
export async function validateSubscriptionTiers() {
  try {
    logger.info("Starting subscription tier validation");

    // Find tiers with missing required fields
    const incompleteTiers = await prisma.subscriptionTier.findMany({
      where: {
        OR: [
          { name: undefined },
          { tierId: undefined },
          { planType: undefined },
        ],
      },
    });

    logger.info(`Found ${incompleteTiers.length} incomplete tiers`);

    // Fix incomplete tiers with reasonable defaults
    for (const tier of incompleteTiers) {
      const updates: any = {};

      if (!tier.name) updates.name = `Tier ${tier.id}`;
      if (!tier.tierId) updates.tierId = SubscriptionTierId.FREE;
      if (!tier.planType) updates.planType = PlanType.MONTHLY;

      if (Object.keys(updates).length > 0) {
        await prisma.subscriptionTier.update({
          where: { id: tier.id },
          data: updates,
        });

        logger.info(`Fixed incomplete tier ${tier.id} with updates:`, updates);
      }
    }

    logger.info("Subscription tier validation complete");

    return {
      incompleteTiers,
      totalFixed: incompleteTiers.length,
    };
  } catch (error) {
    logger.error("Error during subscription tier validation:", error);
    throw error;
  }
}
