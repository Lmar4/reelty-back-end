import { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.js";

const prisma = new PrismaClient();

export class UserCreditsService {
  /**
   * Add credits to a user and update all necessary tables
   */
  async addCreditsToUser(
    userId: string,
    creditsToAdd: number,
    adminId: string,
    reason: string = "Admin adjustment"
  ) {
    try {
      // Start a transaction to ensure all updates succeed or fail together
      return await prisma.$transaction(async (tx) => {
        // 1. Find the user and their current tier
        const user = await tx.user.findUnique({
          where: { id: userId },
          include: { currentTier: true },
        });

        if (!user) {
          throw new Error(`User with ID ${userId} not found`);
        }

        // 2. Update or create ListingCredit record
        const existingCredit = await tx.listingCredit.findFirst({
          where: { userId },
        });

        if (existingCredit) {
          await tx.listingCredit.update({
            where: { id: existingCredit.id },
            data: {
              creditsRemaining: existingCredit.creditsRemaining + creditsToAdd,
            },
          });
        } else {
          await tx.listingCredit.create({
            data: {
              userId,
              creditsRemaining: creditsToAdd,
            },
          });
        }

        // 3. Log the credit change
        await tx.creditLog.create({
          data: {
            userId,
            adminId,
            amount: creditsToAdd,
            reason,
          },
        });

        // 4. Return the updated user with their new credit total
        const updatedCredit = await tx.listingCredit.findFirst({
          where: { userId },
        });

        return {
          user,
          creditsRemaining: updatedCredit?.creditsRemaining || creditsToAdd,
        };
      });
    } catch (error) {
      logger.error("Error adding credits to user", {
        userId,
        creditsToAdd,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Remove credits from a user
   */
  async removeCreditsFromUser(
    userId: string,
    creditsToRemove: number,
    adminId: string,
    reason: string = "Admin adjustment"
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Find the user's current credits
        const existingCredit = await tx.listingCredit.findFirst({
          where: { userId },
        });

        if (!existingCredit) {
          throw new Error(`User ${userId} has no credits to remove`);
        }

        if (existingCredit.creditsRemaining < creditsToRemove) {
          throw new Error(
            `Cannot remove ${creditsToRemove} credits. User only has ${existingCredit.creditsRemaining}`
          );
        }

        // Update the listing credit
        await tx.listingCredit.update({
          where: { id: existingCredit.id },
          data: {
            creditsRemaining: existingCredit.creditsRemaining - creditsToRemove,
          },
        });

        // Log the credit change (negative amount)
        await tx.creditLog.create({
          data: {
            userId,
            adminId,
            amount: -creditsToRemove,
            reason,
          },
        });

        // Return the updated credit info
        const updatedCredit = await tx.listingCredit.findFirst({
          where: { userId },
        });

        return {
          creditsRemaining: updatedCredit?.creditsRemaining || 0,
        };
      });
    } catch (error) {
      logger.error("Error removing credits from user", {
        userId,
        creditsToRemove,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Get a user's current credits
   */
  async getUserCredits(userId: string) {
    const creditRecord = await prisma.listingCredit.findFirst({
      where: { userId },
    });

    return creditRecord?.creditsRemaining || 0;
  }
}

export const userCreditsService = new UserCreditsService();
