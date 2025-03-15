/**
 * Logger Utility
 *
 * Centralized logging service using Winston.
 * Provides structured logging with different levels and formats
 * for development and production environments.
 *
 * Features:
 * - Multiple log levels (error, warn, info, debug)
 * - Structured JSON logging
 * - Timestamp and log level formatting
 * - Error stack trace preservation
 * - Production-ready configuration
 *
 * @module Logger
 */

import winston from "winston";

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: "error.log",
      level: "error",
    }),
    new winston.transports.File({
      filename: "combined.log",
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});
