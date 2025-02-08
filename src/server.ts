import express, {
  NextFunction,
  Request,
  Response,
  ErrorRequestHandler,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import { clerkClient, requireAuth } from "@clerk/express";
import router from "./routes";
import usersRoutes from "./routes/users";
import subscriptionRoutes from "./routes/subscription";
import storageRoutes from "./routes/storage";
import jobRoutes from "./routes/job";
import creditsRoutes from "./routes/credits";
import adminRoutes from "./routes/admin";
import { timeoutMiddleware } from "./middleware/timeout";
import { DatabaseMonitor } from "./utils/db-monitor";
import { logger } from "./utils/logger";
import { basePrisma } from "./config/database";

// Add global error handlers
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  // Give time for logging before exiting
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

const app = express();

// Add request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    query: req.query,
    headers: req.headers,
    timestamp: new Date().toISOString(),
  });
  next();
});

// Add timeout middleware first
app.use(timeoutMiddleware(15000)); // 15 second timeout

// Apply CORS middleware with more specific configuration
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        process.env.FRONTEND_URL || "http://localhost:3000",
        // Add other allowed origins if needed
      ];

      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) === -1) {
        logger.warn(`Blocked request from unauthorized origin: ${origin}`);
        return callback(new Error("Not allowed by CORS"), false);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON bodies with size limit
app.use(express.json({ limit: "10mb" }));

// Initialize authenticated router with Clerk middleware
const authenticatedRouter = express.Router();

// Initialize Clerk
authenticatedRouter.use((req: Request, res: Response, next: NextFunction) => {
  try {
    requireAuth()(req, res, next);
  } catch (error) {
    logger.error("Clerk Authentication Error:", error);
    res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
});

// Mount base router that includes listings and templates first
authenticatedRouter.use("/", router);

// Then mount feature routes
authenticatedRouter.use("/users", usersRoutes);
authenticatedRouter.use("/subscription", subscriptionRoutes);
authenticatedRouter.use("/storage", storageRoutes);
authenticatedRouter.use("/job", jobRoutes);
authenticatedRouter.use("/credits", creditsRoutes);
authenticatedRouter.use("/admin", adminRoutes);

// Mount all authenticated routes under /api
app.use("/api", authenticatedRouter);

// Add basic root route handler
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "API is running",
    version: process.env.API_VERSION || "1.0.0",
  });
});

// Health check endpoint
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Service is healthy",
    timestamp: new Date().toISOString(),
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    code: "NOT_FOUND",
    message: "The requested resource was not found",
  });
});

// Start the server
const port = parseInt(process.env.PORT || "8080", 10);

const start = async () => {
  try {
    // Test database connection before starting
    await basePrisma.$connect();
    logger.info("Database connection successful");

    const dbMonitor = new DatabaseMonitor(basePrisma, logger);
    await dbMonitor.start();
    logger.info("Database monitor started successfully");

    app.listen(port, "::", () => {
      logger.info("Server started", {
        port,
        env: process.env.NODE_ENV,
        frontendUrl: process.env.FRONTEND_URL,
      });
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received. Starting graceful shutdown...");
  await basePrisma.$disconnect();
  process.exit(0);
});

start().catch((error) => {
  logger.error("Failed to start application:", error);
  process.exit(1);
});

export default app;
