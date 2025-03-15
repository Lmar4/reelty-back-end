import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger.js";

// Connection pool configuration
const POOL_CONFIG = {
  connection: {
    min: Number(process.env.PRISMA_CONNECTION_POOL_MIN || 2),
    max: Number(process.env.PRISMA_CONNECTION_POOL_MAX || 10),
    idle: Number(process.env.PRISMA_CONNECTION_POOL_IDLE || 60000),
  },
  acquire: {
    timeout: Number(process.env.PRISMA_CONNECTION_TIMEOUT || 30000),
    retries: Number(process.env.PRISMA_CONNECTION_RETRIES || 3),
  },
};

// Create a singleton instance of PrismaClient
declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

// Register event handlers for connection issues
// @ts-ignore - Prisma types are not correctly defined for event handlers
prisma.$on("query", (e: any) => {
  if (process.env.NODE_ENV === "development") {
    logger.debug(`Query: ${e.query}`);
    logger.debug(`Duration: ${e.duration}ms`);
  }
});

// @ts-ignore - Prisma types are not correctly defined for event handlers
prisma.$on("error", (e: any) => {
  logger.error("Prisma Client error:", e);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  logger.info("SIGINT received, closing database connections");
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, closing database connections");
  await prisma.$disconnect();
  process.exit(0);
});

// In development, don't keep the connection between hot reloads
if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
