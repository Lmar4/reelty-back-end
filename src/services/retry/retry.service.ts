// src/services/retry/retry.service.ts
import { logger } from "../../utils/logger.js";

interface RetryOptions {
  maxRetries?: number;
  delays?: number[];
  jobId: string;
}

export class RetryService {
  private static instance: RetryService;
  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly DEFAULT_DELAYS = [2000, 5000, 10000]; // ms

  private constructor() {}

  public static getInstance(): RetryService {
    if (!RetryService.instance) {
      RetryService.instance = new RetryService();
    }
    return RetryService.instance;
  }

  async withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? this.DEFAULT_MAX_RETRIES;
    const delays = options.delays ?? this.DEFAULT_DELAYS;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries - 1) {
          const delay = delays[attempt] || delays[delays.length - 1];

          logger.warn(
            `[${options.jobId}] Operation failed, retrying in ${delay}ms`,
            {
              attempt: attempt + 1,
              maxRetries,
              error: lastError.message,
            }
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}

export const retryService = RetryService.getInstance();
