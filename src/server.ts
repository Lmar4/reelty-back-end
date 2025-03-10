import { clerkMiddleware } from "@clerk/express";
import compression from "compression";
import cors from "cors";
import express, { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import adminRouter from "./routes/admin/index.js";
import creditsRouter from "./routes/credits.js";
import jobsRouter from "./routes/job.js";
import listingsRouter from "./routes/listings.js";
import photosRouter from "./routes/photos.js";
import subscriptionRouter from "./routes/subscription.js";
import templatesRouter from "./routes/templates.js";
import usersRouter from "./routes/users.js";
import clerkWebhookRouter from "./routes/webhooks/clerk.js";
import { videosRouter } from "./routes/videos.js";
import { logger } from "./utils/logger.js";
import v8 from "v8";
import { initializeJobs } from "./jobs/index.js";

logger.info("V8 Heap Space Statistics", v8.getHeapSpaceStatistics());
const app = express();
const port = Number(process.env.PORT) || 3001;

// Trust proxy settings
app.set("trust proxy", 1);

// Security and performance middleware
app.use(helmet());
app.use(compression());

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

// Log CORS preflight requests for debugging
app.use((req: Request, res: Response, next: Function) => {
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
  }
  next();
});

// Static CORS configuration
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, curl requests)
      if (!origin) {
        logger.info("Allowing request with no origin");
        return callback(null, true);
      }

      // Log all incoming origins for debugging
      logger.info(`Received request with origin: ${origin}`);

      // Check if the origin is in our list of allowed origins
      if (validCorsOrigins.indexOf(origin) !== -1) {
        logger.info(`Origin ${origin} is allowed by CORS policy`);
        return callback(null, true);
      } else {
        // Try to match with a more flexible approach (for subdomain handling)
        const isAllowed = validCorsOrigins.some((allowedOrigin) => {
          // Convert to regex pattern that would match the domain with or without www
          const allowedDomain = allowedOrigin.replace(
            /^https?:\/\/(www\.)?/,
            ""
          );
          // Create a regex that matches the domain regardless of protocol and www prefix
          const pattern = `^https?://(www\\.)?${allowedDomain.replace(
            /\./g,
            "\\."
          )}$`;
          const regex = new RegExp(pattern);
          logger.info(`Checking origin ${origin} against pattern ${pattern}`);
          return regex.test(origin);
        });

        if (isAllowed) {
          logger.info(`Origin ${origin} is allowed by flexible CORS matching`);
          return callback(null, true);
        }

        logger.warn(`Request from unauthorized origin rejected: ${origin}`);
        return callback(
          new Error(`Origin ${origin} not allowed by CORS policy`),
          false
        );
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id"],
    exposedHeaders: ["Access-Control-Allow-Origin"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// Additional middleware to ensure CORS headers are set
app.use((req: Request, res: Response, next: Function) => {
  const origin = req.headers.origin;

  // If the origin is allowed, set the header explicitly
  if (origin && validCorsOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  } else if (origin) {
    // Check with the more flexible approach
    const isAllowed = validCorsOrigins.some((allowedOrigin) => {
      const allowedDomain = allowedOrigin.replace(/^https?:\/\/(www\.)?/, "");
      const pattern = `^https?://(www\\.)?${allowedDomain.replace(
        /\./g,
        "\\."
      )}$`;
      const regex = new RegExp(pattern);
      return regex.test(origin);
    });

    if (isAllowed) {
      res.header("Access-Control-Allow-Origin", origin);
    }
  }

  // Set other CORS headers
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-User-Id"
  );
  res.header("Access-Control-Allow-Credentials", "true");

  next();
});

// Parse JSON bodies with raw body access for webhooks
app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      // Store the raw body for webhook verification
      const rawBody = buf.toString();
      (req as any).rawBody = rawBody;

      // Debug log for webhook requests
      if (req.path.includes("/webhooks/")) {
        logger.info("[Express JSON Parser]", {
          path: req.path,
          method: req.method,
          contentType: req.headers["content-type"],
          contentLength: req.headers["content-length"],
          rawBodyLength: rawBody.length,
          // Log the first 50 characters of the raw body for debugging
          rawBodyPreview:
            rawBody.substring(0, 50) + (rawBody.length > 50 ? "..." : ""),
          // Log important webhook headers
          webhookHeaders: {
            "svix-id": req.headers["svix-id"] || "missing",
            "svix-timestamp": req.headers["svix-timestamp"] || "missing",
            "svix-signature": req.headers["svix-signature"]
              ? "present"
              : "missing",
          },
        });
      }
    },
    limit: "10mb", // Increase payload size limit
  })
);

// Add a special raw body parser for webhook routes
app.use("/webhooks", (req, res, next) => {
  // If we already have the raw body from the JSON parser, continue
  if ((req as any).rawBody) {
    next();
    return;
  }

  // For non-JSON content types, we need to manually capture the raw body
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
  });

  req.on("end", () => {
    (req as any).rawBody = data;
    logger.info("[Webhook Raw Body Parser]", {
      path: req.path,
      method: req.method,
      contentType: req.headers["content-type"],
      rawBodyLength: data.length,
    });
    next();
  });
});

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

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ success: true, message: "OK" });
});

// CORS test endpoint
app.get("/cors-test", (req: Request, res: Response) => {
  const origin = req.headers.origin || "No origin";
  const allowedOrigins = validCorsOrigins.join(", ");

  res.json({
    success: true,
    message: "CORS is working correctly if you can see this message",
    requestOrigin: origin,
    allowedOrigins: allowedOrigins,
    corsHeadersSet: {
      "access-control-allow-origin": res.getHeader(
        "Access-Control-Allow-Origin"
      ),
      "access-control-allow-methods": res.getHeader(
        "Access-Control-Allow-Methods"
      ),
      "access-control-allow-headers": res.getHeader(
        "Access-Control-Allow-Headers"
      ),
      "access-control-allow-credentials": res.getHeader(
        "Access-Control-Allow-Credentials"
      ),
    },
  });
});

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
app.use((err: Error, _req: Request, res: Response, _next: Function) => {
  logger.error("Unhandled error:", {
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({ success: false, error: err.message });
});

// Start server
app.listen(port, "0.0.0.0", () => {
  logger.info(`Server started on port ${port}`);
  // We already log CORS origins at configuration time, so we don't need to log it again here

  // Initialize scheduled jobs
  initializeJobs();
});
