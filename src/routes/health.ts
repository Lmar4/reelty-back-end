import express from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { withDbRetry } from "../utils/dbRetry.js";

const router = express.Router();

/**
 * GET /api/health/db
 * Database health check endpoint
 * Returns database connection status and metrics
 */
async function dbHealthCheck(req: Request, res: Response) {
  try {
    const startTime = Date.now();

    // Use the retry utility for the health check
    await withDbRetry(
      async () => {
        return prisma.$queryRaw`SELECT 1`;
      },
      2,
      500
    ); // Only 2 retries with 500ms delay for health checks

    const duration = Date.now() - startTime;

    // Get connection metrics
    const metrics = {
      responseTime: `${duration}ms`,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || "unknown",
      poolConfig: {
        min: process.env.PRISMA_CONNECTION_POOL_MIN || "2",
        max: process.env.PRISMA_CONNECTION_POOL_MAX || "10",
        idle: process.env.PRISMA_CONNECTION_POOL_IDLE || "60000",
        timeout: process.env.PRISMA_CONNECTION_TIMEOUT || "30000",
        retries: process.env.PRISMA_CONNECTION_RETRIES || "3",
      },
    };

    return res.json({
      success: true,
      status: "healthy",
      message: "Database connection is healthy",
      ...metrics,
    });
  } catch (error) {
    logger.error("Database health check failed:", error);
    return res.status(503).json({
      success: false,
      status: "unhealthy",
      message: "Database connection is unhealthy",
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/health
 * General API health check endpoint
 */
function apiHealthCheck(req: Request, res: Response) {
  return res.json({
    success: true,
    status: "healthy",
    message: "API is running",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "unknown",
    environment: process.env.NODE_ENV || "unknown",
  });
}

// Register routes
router.get("/health/db", dbHealthCheck);
router.get("/health", apiHealthCheck);

export default router;
