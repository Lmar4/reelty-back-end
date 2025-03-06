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
      select: {
        id: true,
        currentTierId: true,
        subscriptionStatus: true,
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

    // Update user with new tier and appropriate status
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        currentTierId: newTierId,
        // Only update status if moving to a paid tier and not already ACTIVE
        ...(isPaidTier &&
          user.subscriptionStatus !== SubscriptionStatus.ACTIVE && {
            subscriptionStatus: SubscriptionStatus.ACTIVE,
          }),
      },
    });

    // Log the tier change
    await prisma.tierChange.create({
      data: {
        userId,
        oldTier: user.currentTierId || newTierId,
        newTier: newTierId,
        reason,
        adminId,
      },
    });

    // If status changed, log that too
    if (isPaidTier && user.subscriptionStatus !== SubscriptionStatus.ACTIVE) {
      await prisma.subscriptionLog.create({
        data: {
          userId,
          action: "STATUS_UPDATED_WITH_TIER_CHANGE",
          stripeSubscriptionId: "manual_tier_change",
          status: SubscriptionStatus.ACTIVE,
        },
      });
    }

    return updatedUser;
  } finally {
    await prisma.$disconnect();
  }
}
