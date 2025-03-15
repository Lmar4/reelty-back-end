import { CronJob } from "cron";
import { logger } from "../utils/logger.js";
import { monthlyCreditsService } from "../services/subscription/monthly-credits.service.js";

/**
 * Job to check for missed monthly credits for lifetime subscribers
 * Runs daily at 10:00 AM
 */
export function setupMissedCreditsCheckJob() {
  // Schedule: 10:00 AM every day
  const job = new CronJob(
    "0 10 * * *",
    async () => {
      logger.info("Running missed credits check job for lifetime subscribers");

      try {
        const result =
          await monthlyCreditsService.checkForMissedMonthlyCredits();

        if (result.success) {
          logger.info(
            `Missed credits check job completed successfully: ${result.processed} processed, ${result.recovered} recovered, ${result.errors} errors`
          );
        } else {
          logger.error(
            `Missed credits check job failed: ${result.processed} processed, ${result.recovered} recovered, ${result.errors} errors`
          );
        }
      } catch (error) {
        logger.error("Error running missed credits check job", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    null,
    true,
    "UTC"
  );

  logger.info("Missed credits check job scheduled");
  return job;
}
