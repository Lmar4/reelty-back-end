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

logger.info("V8 Heap Space Statistics", v8.getHeapSpaceStatistics());
const app = express();
const port = Number(process.env.PORT) || 3001;

// Trust proxy settings
app.set("trust proxy", 1);

// Security and performance middleware
app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id"],
  })
);

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
        });
      }
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

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ success: true, message: "OK" });
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
});
