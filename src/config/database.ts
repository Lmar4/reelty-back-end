import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger.js";

// Create base client for internal use
const baseClient = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  log: ["query", "error", "warn"],
});

// Create extended client for query logging
export const prisma = baseClient.$extends({
  query: {
    async $allOperations({ operation, model, args, query }) {
      const start = performance.now();
      const result = await query(args);
      const end = performance.now();

      if (end - start > 1000) {
        // Log slow queries (>1s)
        logger.warn("Slow query detected", {
          model,
          operation,
          duration: `${end - start}ms`,
          args,
        });
      }

      return result;
    },
  },
});

// Export base client for DatabaseMonitor
export const basePrisma = baseClient;
