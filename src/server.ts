import express, {
  NextFunction,
  Request,
  Response,
  ErrorRequestHandler,
} from "express";
import cors from "cors";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import userRoutes from "./routes/user";
import storageRoutes from "./routes/storage";
import jobRoutes from "./routes/job";
import subscriptionRoutes from "./routes/subscription";
import authRoutes from "./routes/auth";
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

// Add basic root route handler
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({ message: "API is running" });
});

// Health check endpoint
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Auth routes (some might be public)
app.use("/api/auth", authRoutes);

// Apply Clerk middleware for all protected routes
const authenticatedRouter = express.Router();
authenticatedRouter.use(clerkMiddleware());
authenticatedRouter.use(requireAuth());

// Protected routes with better error handling
authenticatedRouter.use("/users", userRoutes);
authenticatedRouter.use("/storage", storageRoutes);
authenticatedRouter.use("/jobs", jobRoutes);
authenticatedRouter.use("/subscription", subscriptionRoutes);
authenticatedRouter.use("/admin", adminRoutes);

// Mount authenticated routes under /api
app.use("/api", authenticatedRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    status: 404,
    message: "The requested resource was not found",
  });
});

// Error handling middleware
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const errorDetails = {
    name: err.name,
    message: err.message,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  };

  logger.error("Request error:", errorDetails);

  if (err.name === "ClerkError") {
    res.status(401).json({
      error: "Authentication failed",
      status: 401,
      message: err.message,
    });
    return;
  }

  // Handle CORS errors
  if (err.message.includes("Not allowed by CORS")) {
    res.status(403).json({
      error: "CORS Error",
      status: 403,
      message: "Origin not allowed",
    });
    return;
  }

  res.status(500).json({
    error: "Internal server error",
    status: 500,
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "An unexpected error occurred",
  });
  return;
};

app.use(errorHandler);

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
