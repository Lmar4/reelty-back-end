import { logger } from "../utils/logger.js";
import { setupMonthlyCreditsJob } from "./monthly-credits.job.js";
import { setupMissedCreditsCheckJob } from "./missed-credits-check.job.js";

/**
 * Initialize all scheduled jobs
 */
export function initializeJobs() {
  logger.info("Initializing scheduled jobs");

  // Set up monthly credits job for lifetime subscribers
  const monthlyCreditsJob = setupMonthlyCreditsJob();

  // Set up daily check for missed monthly credits
  const missedCreditsCheckJob = setupMissedCreditsCheckJob();

  logger.info("All scheduled jobs initialized");

  return {
    monthlyCreditsJob,
    missedCreditsCheckJob,
  };
}
