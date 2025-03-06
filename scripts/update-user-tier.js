import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  try {
    // First, let's check if the user exists
    const userId = "user_2tvB0WP3fNPjkXlvKa8Ky33DRTo"; // The user ID from your error message
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { currentTier: true },
    });

    if (!user) {
      console.error(`User with ID ${userId} not found`);
      return;
    }

    console.log("Current user data:", {
      id: user.id,
      email: user.email,
      currentTierId: user.currentTierId,
      currentTier: user.currentTier
        ? {
            id: user.currentTier.id,
            name: user.currentTier.name,
            tierId: user.currentTier.tierId,
          }
        : null,
    });

    // Get the subscription tier you want to assign
    // Replace 'REELTY_PRO' with the tier you want to assign (FREE, REELTY, REELTY_PRO, REELTY_PRO_PLUS)
    const tierIdToAssign = "REELTY_PRO_PLUS";

    const tier = await prisma.subscriptionTier.findUnique({
      where: { tierId: tierIdToAssign },
    });

    if (!tier) {
      console.error(`Subscription tier with ID ${tierIdToAssign} not found`);
      return;
    }

    console.log("Found tier:", {
      id: tier.id,
      name: tier.name,
      tierId: tier.tierId,
    });

    // Update the user with the new tier
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        currentTierId: tierIdToAssign,
      },
      include: { currentTier: true },
    });

    console.log("User updated successfully:", {
      id: updatedUser.id,
      email: updatedUser.email,
      currentTierId: updatedUser.currentTierId,
      currentTier: updatedUser.currentTier
        ? {
            id: updatedUser.currentTier.id,
            name: updatedUser.currentTier.name,
            tierId: updatedUser.currentTier.tierId,
          }
        : null,
    });
  } catch (error) {
    console.error("Error updating user tier:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
