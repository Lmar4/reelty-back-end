import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
} from "@prisma/client";

const prisma = new PrismaClient();

// Ensure Prisma's SubscriptionTierId includes all necessary values
// If needed, update the Prisma schema to include 'FREE' in SubscriptionTierId

export async function updateUserTier(
  userId: string,
  newTierId: SubscriptionTierId,
  reason: string,
  adminId?: string
) {
  try {
    // Get current user data
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscriptions: {
          where: {
            status: {
              not: SubscriptionStatus.INACTIVE,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new Error(`User with ID ${userId} not found`);
    }

    // Determine if this is a paid tier
    const paidTiers: SubscriptionTierId[] = [
      SubscriptionTierId.REELTY,
      SubscriptionTierId.REELTY_PRO,
      SubscriptionTierId.REELTY_PRO_PLUS,
    ];
    const isPaidTier = paidTiers.includes(newTierId);

    // Get the active subscription
    const activeSubscription = user.subscriptions[0];

    if (activeSubscription) {
      // Update existing subscription
      await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          tierId: newTierId,
          // Only update status if moving to a paid tier and not already ACTIVE
          ...(isPaidTier &&
            activeSubscription.status !== SubscriptionStatus.ACTIVE && {
              status: SubscriptionStatus.ACTIVE,
            }),
        },
      });
    } else {
      // Create new subscription
      const newSubscription = await prisma.subscription.create({
        data: {
          userId,
          tierId: newTierId,
          status: isPaidTier
            ? SubscriptionStatus.ACTIVE
            : SubscriptionStatus.INACTIVE,
        },
      });

      // Set as active subscription
      await prisma.user.update({
        where: { id: userId },
        data: {
          activeSubscriptionId: newSubscription.id,
        },
      });
    }

    // Log the tier change
    await prisma.tierChange.create({
      data: {
        userId,
        oldTier: activeSubscription?.tierId || SubscriptionTierId.FREE,
        newTier: newTierId,
        reason,
        adminId,
      },
    });

    // Log subscription change
    await prisma.subscriptionLog.create({
      data: {
        userId,
        action: adminId ? "TIER_CHANGED_BY_ADMIN" : "TIER_CHANGED",
        status: isPaidTier
          ? SubscriptionStatus.ACTIVE
          : SubscriptionStatus.INACTIVE,
        stripeSubscriptionId:
          activeSubscription?.stripeSubscriptionId || "manual_update",
      },
    });

    return await prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscriptions: {
          where: {
            status: {
              not: SubscriptionStatus.INACTIVE,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
          include: {
            tier: true,
          },
        },
      },
    });
  } catch (error) {
    console.error("Error updating user tier:", error);
    throw error;
  }
}
