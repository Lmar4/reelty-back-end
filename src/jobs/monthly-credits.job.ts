import { CronJob } from "cron";
import { logger } from "../utils/logger.js";
import { monthlyCreditsService } from "../services/subscription/monthly-credits.service.js";

/**
 * Job to add monthly credits to lifetime subscribers
 * Runs on the 1st day of each month at 00:01 AM
 */
export function setupMonthlyCreditsJob() {
  // Schedule: 1 minute after midnight on the 1st day of each month
  const job = new CronJob(
    "1 0 1 * *",
    async () => {
      logger.info("Running monthly credits job for lifetime subscribers");

      try {
        const result =
          await monthlyCreditsService.addMonthlyCreditsToLifetimeSubscribers();

        if (result.success) {
          logger.info(
            `Monthly credits job completed successfully: ${result.processed} processed, ${result.errors} errors`
          );
        } else {
          logger.error(
            `Monthly credits job failed: ${result.processed} processed, ${result.errors} errors`
          );
        }
      } catch (error) {
        logger.error("Error running monthly credits job", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    null,
    true,
    "UTC"
  );

  logger.info("Monthly credits job scheduled");
  return job;
}
