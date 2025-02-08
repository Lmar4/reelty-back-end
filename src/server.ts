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
const app = express();

// Add timeout middleware first
app.use(timeoutMiddleware(15000)); // 15 second timeout

// Apply CORS middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Parse JSON bodies
app.use(express.json());

// Public routes (no auth required)
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// Auth routes (some might be public)
app.use("/api/auth", authRoutes);

// Apply Clerk middleware for all protected routes
const authenticatedRouter = express.Router();
authenticatedRouter.use(clerkMiddleware());
authenticatedRouter.use(requireAuth());

// Protected routes
authenticatedRouter.use("/users", userRoutes);
authenticatedRouter.use("/storage", storageRoutes);
authenticatedRouter.use("/jobs", jobRoutes);
authenticatedRouter.use("/subscription", subscriptionRoutes);

// Admin routes (requires additional admin check)
authenticatedRouter.use("/admin", adminRoutes);

// Mount authenticated routes under /api
app.use("/api", authenticatedRouter);

// Error handling middleware
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("Error:", err);

  if (err.name === "ClerkError") {
    res.status(401).json({
      error: "Authentication failed",
      status: 401,
    });
    return;
  }

  res.status(500).json({
    error: "Internal server error",
    status: 500,
  });
  return;
};

app.use(errorHandler);

// Start the server
const port = parseInt(process.env.PORT || "3001", 10);

const dbMonitor = new DatabaseMonitor(basePrisma, logger);
dbMonitor.start();

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
