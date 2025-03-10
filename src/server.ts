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

// Special middleware to handle Railway.app proxy behavior
app.use((req: Request, res: Response, next: Function) => {
  // Check for Railway-specific headers
  const railwayOrigin = req.headers["x-forwarded-host"] || req.headers.host;
  const railwayProto = req.headers["x-forwarded-proto"] || req.protocol;

  // Log Railway-specific headers for debugging
  logger.info("Railway proxy headers", {
    "x-forwarded-host": req.headers["x-forwarded-host"],
    "x-forwarded-proto": req.headers["x-forwarded-proto"],
    "x-forwarded-for": req.headers["x-forwarded-for"],
    host: req.headers.host,
    origin: req.headers.origin,
  });

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

// CORS configuration - more permissive for troubleshooting
const corsOptions = {
  origin: function (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) {
    // For development or testing - allow requests with no origin
    if (!origin) {
      logger.info("Request with no origin - allowing access");
      return callback(null, true);
    }

    logger.info(`Checking CORS for origin: ${origin}`);

    // First check exact match
    if (validCorsOrigins.includes(origin)) {
      logger.info(`Origin ${origin} is explicitly allowed`);
      return callback(null, true);
    }

    // Then check for domain match (with or without www)
    for (const allowedOrigin of validCorsOrigins) {
      // Extract domain from allowed origin
      const allowedDomain = allowedOrigin.replace(/^https?:\/\/(www\.)?/, "");
      // Extract domain from request origin
      const requestDomain = origin.replace(/^https?:\/\/(www\.)?/, "");

      if (allowedDomain === requestDomain) {
        logger.info(
          `Origin ${origin} matches domain pattern for ${allowedOrigin}`
        );
        return callback(null, true);
      }
    }

    // If we get here, the origin is not allowed
    logger.warn(`Origin ${origin} is not allowed by CORS policy`);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-User-Id",
    "Origin",
    "Accept",
  ],
  exposedHeaders: ["Access-Control-Allow-Origin"],
  maxAge: 86400, // 24 hours in seconds
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

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

// Apply CORS configuration
app.use(cors(corsOptions));

// Additional middleware to ensure CORS headers are set correctly
app.use((req: Request, res: Response, next: Function) => {
  const origin = req.headers.origin;

  // If there's an origin header and it's allowed, set the CORS headers explicitly
  if (origin) {
    // Check if origin is allowed using the same logic as in corsOptions
    let isAllowed = validCorsOrigins.includes(origin);

    if (!isAllowed) {
      // Check domain match
      for (const allowedOrigin of validCorsOrigins) {
        const allowedDomain = allowedOrigin.replace(/^https?:\/\/(www\.)?/, "");
        const requestDomain = origin.replace(/^https?:\/\/(www\.)?/, "");

        if (allowedDomain === requestDomain) {
          isAllowed = true;
          break;
        }
      }
    }

    if (isAllowed) {
      // Set explicit CORS headers
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Credentials", "true");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS, PATCH"
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-User-Id, Origin, Accept"
      );

      // Log that we're setting headers
      logger.info(`Explicitly setting CORS headers for origin: ${origin}`);
    }
  }

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
      methods: corsOptions.methods,
      allowedHeaders: corsOptions.allowedHeaders,
      exposedHeaders: corsOptions.exposedHeaders,
      credentials: corsOptions.credentials,
      maxAge: corsOptions.maxAge,
    },
    responseHeaders: responseHeaders,
    environment: {
      nodeEnv: process.env.NODE_ENV || "Not set",
      frontendUrl: process.env.FRONTEND_URL || "Not set",
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
