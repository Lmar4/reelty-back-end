import { validateUserData } from "../src/services/validation.service.js";
import { logger } from "../src/utils/logger.js";

/**
 * Script to validate user data consistency between tiers and subscription statuses
 */
async function runValidation() {
  try {
    logger.info("Starting user data validation...");
    const result = await validateUserData();

    logger.info("Validation complete", {
      inconsistentUsers: result.inconsistentUsers.length,
      freeActiveUsers: result.freeActiveUsers.length,
      nullTierUsers: result.nullTierUsers.length,
      totalFixed: result.totalFixed,
    });

    return result;
  } catch (error) {
    logger.error("Error during validation:", error);
    throw error;
  }
}

// Run the validation
runValidation()
  .then((result) => {
    logger.info(
      `Validation completed successfully. Fixed ${result.totalFixed} users.`
    );
    process.exit(0);
  })
  .catch((error) => {
    logger.error("Validation failed:", error);
    process.exit(1);
  });

// Export for testing or manual invocation
export { runValidation };
