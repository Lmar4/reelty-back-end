import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";

// Track database connection status
let isDbHealthy = true;
let lastHealthCheckTime = 0;
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute

/**
 * Middleware to check database health before processing requests
 * Only performs health check at specified intervals to avoid excessive database queries
 */
export async function dbHealthCheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const currentTime = Date.now();

  // Only perform health check if it's been more than the interval since the last check
  if (currentTime - lastHealthCheckTime > HEALTH_CHECK_INTERVAL) {
    try {
      // Simple query to check database connectivity
      await prisma.$queryRaw`SELECT 1`;

      if (!isDbHealthy) {
        logger.info("Database connection restored");
        isDbHealthy = true;
      }
    } catch (error) {
      logger.error("Database health check failed:", error);
      isDbHealthy = false;

      // Return 503 Service Unavailable if the database is down
      res.status(503).json({
        success: false,
        error: "Database service unavailable",
        message:
          "The service is temporarily unavailable. Please try again later.",
      });
      return;
    } finally {
      lastHealthCheckTime = currentTime;
    }
  }

  // If database is healthy, proceed to the next middleware
  if (isDbHealthy) {
    next();
  } else {
    res.status(503).json({
      success: false,
      error: "Database service unavailable",
      message:
        "The service is temporarily unavailable. Please try again later.",
    });
  }
}
