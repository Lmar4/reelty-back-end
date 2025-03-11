import express from "express";
import { logger } from "../utils/logger.js";

type CorsOptions = {
  allowedOrigins?: string[];
  allowedMethods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
  credentials?: boolean;
};

/**
 * CORS middleware for Express applications
 * Configures Cross-Origin Resource Sharing headers based on environment settings
 */
export function configureCors(options: CorsOptions = {}) {
  // Parse allowed origins from environment variable or use provided options
  const envOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map(origin => origin.trim())
    : [];
  
  const allowedOrigins = options.allowedOrigins || envOrigins;
  const allowedMethods = options.allowedMethods || ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
  const allowedHeaders = options.allowedHeaders || [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin"
  ];
  const exposedHeaders = options.exposedHeaders || [];
  const maxAge = options.maxAge || 86400; // 24 hours
  const credentials = options.credentials !== undefined ? options.credentials : true;

  logger.info(`CORS configured with allowed origins: ${allowedOrigins.join(", ")}`);

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.headers.origin;
    
    // Check if the request origin is allowed
    if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else if (allowedOrigins.includes("*")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin) {
      // Log when rejecting an origin
      logger.warn(`CORS: Rejecting request from unauthorized origin: ${origin}`);
    }

    // Set other CORS headers
    if (credentials) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    
    res.setHeader("Access-Control-Allow-Methods", allowedMethods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    
    if (exposedHeaders.length > 0) {
      res.setHeader("Access-Control-Expose-Headers", exposedHeaders.join(", "));
    }
    
    res.setHeader("Access-Control-Max-Age", maxAge.toString());

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    next();
  };
}