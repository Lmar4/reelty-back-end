import { logger } from "./logger.js";

type RetryableFunction<T> = () => Promise<T>;

/**
 * Utility function to retry database operations with exponential backoff
 * @param fn Function to retry
 * @param retries Maximum number of retry attempts
 * @param delay Base delay in milliseconds
 * @returns Result of the function
 */
export async function withDbRetry<T>(
  fn: RetryableFunction<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Only retry on specific errors that indicate connection issues
      const isRetryableError =
        error instanceof Error &&
        (error.message.includes("Connection") ||
          error.message.includes("timeout") ||
          error.message.includes("connection reset") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("pool") ||
          error.message.includes("Connection terminated unexpectedly"));

      if (!isRetryableError) {
        throw error;
      }

      logger.warn(
        `Database operation failed (attempt ${attempt}/${retries}):`,
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
        }
      );

      if (attempt < retries) {
        // Exponential backoff
        const backoffDelay = delay * Math.pow(2, attempt - 1);
        logger.info(`Retrying in ${backoffDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }
  }

  // If we've exhausted all retries, throw the last error
  logger.error(`Database operation failed after ${retries} attempts`);
  throw lastError;
}
