import { clerkMiddleware } from "@clerk/express";
import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import v8 from "v8";
import { initializeJobs } from "./jobs/index.js";
import { prisma } from "./lib/prisma.js";
import { configureCors } from "./middleware/cors.js";
import { dbHealthCheck } from "./middleware/dbHealthCheck.js";
import adminRouter from "./routes/admin/index.js";
import creditsRouter from "./routes/credits.js";
import healthRoutes from "./routes/health.js";
import jobsRouter from "./routes/job.js";
import listingsRouter from "./routes/listings.js";
import photosRouter from "./routes/photos.js";
import subscriptionRouter from "./routes/subscription.js";
import templatesRouter from "./routes/templates.js";
import usersRouter from "./routes/users.js";
import { videosRouter } from "./routes/videos.js";
import clerkWebhookRouter from "./routes/webhooks/clerk.js";
import { logger } from "./utils/logger.js";

// Enhance DATABASE_URL with connection pool parameters if not already present
if (
  process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes("pool_timeout")
) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);

    // Add connection pool parameters to the URL
    dbUrl.searchParams.set(
      "pool_timeout",
      process.env.PRISMA_CONNECTION_TIMEOUT || "30000"
    );
    dbUrl.searchParams.set(
      "connection_limit",
      process.env.PRISMA_CONNECTION_POOL_MAX || "10"
    );
    dbUrl.searchParams.set("statement_timeout", "60000");
    dbUrl.searchParams.set("idle_in_transaction_session_timeout", "60000");

    // Update the environment variable
    process.env.DATABASE_URL = dbUrl.toString();

    logger.info("Enhanced DATABASE_URL with connection pool parameters");
  } catch (error) {
    logger.error(
      "Failed to enhance DATABASE_URL with connection pool parameters:",
      error
    );
  }
}

logger.info("V8 Heap Space Statistics", v8.getHeapSpaceStatistics());
const app = express();
const port = Number(process.env.PORT) || 3001;

// Parse FRONTEND_URL to handle multiple origins
const corsOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map((origin) => origin.trim())
  : ["http://localhost:3000"];

// Validate each origin to ensure they don't contain invalid characters
const validCorsOrigins = corsOrigins.filter((origin) => {
  // Basic URL validation - should start with http:// or https://
  const isValid =
    /^https?:\/\/[a-zA-Z0-9-_.]+(\.[a-zA-Z0-9-_.]+)*(:[0-9]+)?$/.test(origin);
  if (!isValid) {
    logger.warn(`Invalid CORS origin detected and will be ignored: ${origin}`);
  }
  return isValid;
});

logger.info(
  `Configuring CORS for origins: ${JSON.stringify(validCorsOrigins)}`
);

// Apply CORS middleware early in the middleware chain
app.use(
  configureCors({
    allowedOrigins: validCorsOrigins,
    allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-User-Id",
      "Origin",
      "Accept",
    ],
    exposedHeaders: ["Access-Control-Allow-Origin"],
    maxAge: 86400, // 24 hours in seconds
    credentials: true,
  }) as express.RequestHandler
);

// Log CORS preflight requests for debugging
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") {
    logger.info("CORS Preflight Request", {
      origin: req.headers.origin,
      method: req.method,
      path: req.path,
      headers: {
        "access-control-request-method":
          req.headers["access-control-request-method"],
        "access-control-request-headers":
          req.headers["access-control-request-headers"],
      },
    });

    // Add response header logging for verification
    res.on("finish", () => {
      logger.info("CORS Preflight Response", {
        statusCode: res.statusCode,
        headers: {
          "access-control-allow-origin": res.getHeader(
            "access-control-allow-origin"
          ),
          "access-control-allow-methods": res.getHeader(
            "access-control-allow-methods"
          ),
          "access-control-allow-headers": res.getHeader(
            "access-control-allow-headers"
          ),
          "access-control-allow-credentials": res.getHeader(
            "access-control-allow-credentials"
          ),
          "access-control-max-age": res.getHeader("access-control-max-age"),
        },
      });
    });
  }
  next();
});

// Special middleware to handle Railway.app proxy behavior
app.use((req: Request, res: Response, next: NextFunction) => {
  // Check for Railway-specific headers
  const railwayOrigin = req.headers["x-forwarded-host"] || req.headers.host;
  const railwayProto = req.headers["x-forwarded-proto"] || req.protocol;

  // If we're behind Railway's proxy and the origin header is missing,
  // but we can reconstruct it from other headers, do so
  if (!req.headers.origin && railwayOrigin && railwayProto) {
    const reconstructedOrigin = `${railwayProto}://${railwayOrigin}`;
    logger.info(`Reconstructing missing origin header: ${reconstructedOrigin}`);
    req.headers.origin = reconstructedOrigin;
  }

  next();
});

// Security and performance middleware
app.use(helmet());
app.use(compression());

// Parse JSON bodies with raw body access for webhooks
app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      // Store the raw body for webhook verification
      const rawBody = buf.toString();
      (req as any).rawBody = rawBody;
    },
    limit: "10mb", // Increase payload size limit
  })
);

// Add Clerk webhook route (before Clerk middleware to keep it public)
app.use("/webhooks/clerk", clerkWebhookRouter);
logger.info("Registered Clerk webhook route at /webhooks/clerk");

// Add Clerk middleware for all other routes
app.use(clerkMiddleware());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Health check endpoints (no auth required)
app.use("/api", healthRoutes);

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ success: true, message: "OK" });
});

// CORS diagnostic endpoint
app.get("/api/cors-test", (req: Request, res: Response) => {
  const origin = req.headers.origin || "No origin";
  const host = req.headers.host || "No host";
  const referer = req.headers.referer || "No referer";

  // Check if this origin would be allowed by our CORS rules
  let isAllowed = false;
  let matchType = "none";

  if (typeof origin === "string") {
    // Check exact match
    if (validCorsOrigins.includes(origin)) {
      isAllowed = true;
      matchType = "exact";
    } else {
      // Check domain match
      for (const allowedOrigin of validCorsOrigins) {
        const allowedDomain = allowedOrigin.replace(/^https?:\/\/(www\.)?/, "");
        const requestDomain = origin.replace(/^https?:\/\/(www\.)?/, "");

        if (allowedDomain === requestDomain) {
          isAllowed = true;
          matchType = "domain";
          break;
        }
      }
    }
  }

  // Get all response headers for debugging
  const responseHeaders: Record<
    string,
    string | string[] | number | undefined
  > = {};
  const headerNames = res.getHeaderNames();
  for (const name of headerNames) {
    responseHeaders[name] = res.getHeader(name);
  }

  // Return comprehensive diagnostic information
  res.json({
    success: true,
    message: "CORS diagnostic information",
    corsStatus: {
      allowed: isAllowed,
      matchType: matchType,
    },
    request: {
      origin: origin,
      host: host,
      referer: referer,
      ip: req.ip,
      method: req.method,
      path: req.path,
      protocol: req.protocol,
      secure: req.secure,
    },
    corsConfig: {
      allowedOrigins: validCorsOrigins,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-User-Id",
        "Origin",
        "Accept",
      ],
      exposedHeaders: ["Access-Control-Allow-Origin"],
      credentials: true,
      maxAge: 86400,
    },
    responseHeaders: responseHeaders,
    environment: {
      nodeEnv: process.env.NODE_ENV || "Not set",
      frontendUrl: process.env.FRONTEND_URL || "Not set",
    },
    verification: {
      preflightTest:
        "To test preflight, send an OPTIONS request to this endpoint",
      preflightUrl: `${req.protocol}://${req.headers.host}/api/cors-test`,
      curlCommand: `curl -X OPTIONS -H "Origin: ${origin}" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: Content-Type" -v ${req.protocol}://${req.headers.host}/api/cors-test`,
    },
  });
});

// Add explicit OPTIONS handler for the test endpoint
app.options("/api/cors-test", (req: Request, res: Response) => {
  // This will be handled by the CORS middleware, but we can add extra verification
  logger.info("Explicit OPTIONS handler for CORS test endpoint", {
    origin: req.headers.origin,
    requestMethod: req.headers["access-control-request-method"],
    requestHeaders: req.headers["access-control-request-headers"],
  });

  // The response will be sent by the CORS middleware
  // This just ensures we have a specific handler for the test endpoint
});

// Apply database health check middleware to all API routes
app.use("/api", dbHealthCheck);

// Routes
app.use("/api/listings", listingsRouter);
app.use("/api/users", usersRouter);
app.use("/api/photos", photosRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/jobs", jobsRouter);
// Mount all admin routes under /api/admin
app.use("/api/admin", adminRouter);
app.use("/api/subscription", subscriptionRouter);
app.use("/api/credits", creditsRouter);
app.use("/api/videos", videosRouter);

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error:", {
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({ success: false, error: err.message });
});

// Graceful shutdown function
const gracefulShutdown = async () => {
  logger.info("Received shutdown signal, closing connections...");

  // Close database connections
  try {
    await prisma.$disconnect();
    logger.info("Database connections closed successfully");
  } catch (error) {
    logger.error("Error closing database connections:", error);
  }

  process.exit(0);
};

// Register shutdown handlers
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Start server
app.listen(port, "0.0.0.0", () => {
  logger.info(`Server started on port ${port}`);
  // We already log CORS origins at configuration time, so we don't need to log it again here

  // Initialize scheduled jobs
  initializeJobs();
});
