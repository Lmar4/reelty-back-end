import {
  PrismaClient,
  SubscriptionStatus,
  SubscriptionTierId,
  CreditSource,
} from "@prisma/client";
import { logger } from "../../utils/logger.js";
import { startOfMonth, isAfter, subDays } from "date-fns";

const prisma = new PrismaClient();

export class MonthlyCreditsService {
  /**
   * Add monthly credits to lifetime subscribers
   * This should be called by a scheduled job at the beginning of each month
   */
  async addMonthlyCreditsToLifetimeSubscribers(): Promise<{
    success: boolean;
    processed: number;
    errors: number;
  }> {
    logger.info("Starting monthly credit allocation for lifetime subscribers");

    let processed = 0;
    let errors = 0;

    try {
      // Find all active lifetime subscriptions
      const lifetimeSubscriptions = await prisma.subscription.findMany({
        where: {
          tier: {
            tierId: "LIFETIME" as SubscriptionTierId,
          },
          status: "ACTIVE" as SubscriptionStatus,
          deletedAt: null,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });

      logger.info(
        `Found ${lifetimeSubscriptions.length} active lifetime subscriptions`
      );

      // Process each subscription
      for (const subscription of lifetimeSubscriptions) {
        try {
          // Get current balance
          const currentBalance = subscription.creditsBalance;

          // Add 2 credits to the subscription
          const updatedSubscription = await prisma.subscription.update({
            where: {
              id: subscription.id,
            },
            data: {
              creditsBalance: {
                increment: 2,
              },
            },
          });

          // Log the credit addition
          await prisma.creditLog.create({
            data: {
              userId: subscription.userId,
              adminId: null,
              amount: 2,
              reason: "Monthly credits for lifetime subscription",
            },
          });

          // Create a credit transaction record
          await prisma.creditTransaction.create({
            data: {
              subscriptionId: subscription.id,
              amount: 2,
              balanceAfter: updatedSubscription.creditsBalance,
              source: CreditSource.SUBSCRIPTION_CHANGE,
              reason: "Monthly credits for lifetime subscription",
              metadata: {
                subscriptionType: "LIFETIME",
                monthlyAllocation: true,
                allocatedAt: new Date().toISOString(),
                forMonth: startOfMonth(new Date()).toISOString(),
              },
            },
          });

          processed++;
          logger.info(
            `Added 2 credits to user ${subscription.user.email} (${subscription.userId})`
          );
        } catch (error) {
          errors++;
          logger.error(
            `Error adding credits to subscription ${subscription.id}`,
            {
              error: error instanceof Error ? error.message : "Unknown error",
              userId: subscription.userId,
              subscriptionId: subscription.id,
            }
          );
        }
      }

      logger.info(
        `Completed monthly credit allocation: ${processed} processed, ${errors} errors`
      );

      return {
        success: true,
        processed,
        errors,
      };
    } catch (error) {
      logger.error("Error in monthly credit allocation process", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return {
        success: false,
        processed,
        errors: errors + 1,
      };
    }
  }

  /**
   * Check for lifetime subscribers who might have missed their monthly credit allocation
   * This should be called by a daily scheduled job as a safeguard
   */
  async checkForMissedMonthlyCredits(): Promise<{
    success: boolean;
    processed: number;
    recovered: number;
    errors: number;
  }> {
    logger.info("Checking for missed monthly credit allocations");

    let processed = 0;
    let recovered = 0;
    let errors = 0;

    try {
      // Get the start of the current month
      const currentMonthStart = startOfMonth(new Date());

      // Find all active lifetime subscriptions
      const lifetimeSubscriptions = await prisma.subscription.findMany({
        where: {
          tier: {
            tierId: "LIFETIME" as SubscriptionTierId,
          },
          status: "ACTIVE" as SubscriptionStatus,
          deletedAt: null,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
            },
          },
          creditTransactions: {
            where: {
              source: CreditSource.SUBSCRIPTION_CHANGE,
              reason: "Monthly credits for lifetime subscription",
              createdAt: {
                gte: currentMonthStart,
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
          },
        },
      });

      logger.info(
        `Found ${lifetimeSubscriptions.length} active lifetime subscriptions to check`
      );

      // Check each subscription for missing credits this month
      for (const subscription of lifetimeSubscriptions) {
        processed++;

        // Skip if they already received credits this month
        if (subscription.creditTransactions.length > 0) {
          continue;
        }

        try {
          // This subscription hasn't received credits this month, add them now
          logger.info(
            `Recovering missed monthly credits for user ${subscription.user.email} (${subscription.userId})`
          );

          // Add 2 credits to the subscription
          const updatedSubscription = await prisma.subscription.update({
            where: {
              id: subscription.id,
            },
            data: {
              creditsBalance: {
                increment: 2,
              },
            },
          });

          // Log the credit addition
          await prisma.creditLog.create({
            data: {
              userId: subscription.userId,
              adminId: null,
              amount: 2,
              reason: "Recovered monthly credits for lifetime subscription",
            },
          });

          // Create a credit transaction record
          await prisma.creditTransaction.create({
            data: {
              subscriptionId: subscription.id,
              amount: 2,
              balanceAfter: updatedSubscription.creditsBalance,
              source: CreditSource.SUBSCRIPTION_CHANGE,
              reason: "Monthly credits for lifetime subscription",
              metadata: {
                subscriptionType: "LIFETIME",
                monthlyAllocation: true,
                allocatedAt: new Date().toISOString(),
                forMonth: currentMonthStart.toISOString(),
                recovered: true,
              },
            },
          });

          recovered++;
        } catch (error) {
          errors++;
          logger.error(
            `Error recovering credits for subscription ${subscription.id}`,
            {
              error: error instanceof Error ? error.message : "Unknown error",
              userId: subscription.userId,
              subscriptionId: subscription.id,
            }
          );
        }
      }

      logger.info(
        `Completed missed credit check: ${processed} checked, ${recovered} recovered, ${errors} errors`
      );

      return {
        success: true,
        processed,
        recovered,
        errors,
      };
    } catch (error) {
      logger.error("Error in missed credit check process", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return {
        success: false,
        processed,
        recovered,
        errors: errors + 1,
      };
    }
  }
}

export const monthlyCreditsService = new MonthlyCreditsService();
