import { clerkMiddleware } from "@clerk/express";
import compression from "compression";
import cors from "cors";
import express, { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import jobsRouter from "./routes/job";
import listingsRouter from "./routes/listings";
import templatesRouter from "./routes/templates";
import usersRouter from "./routes/users";
import adminRouter from "./routes/admin";
import agencyRoutes from "./routes/agency";
import bulkDiscountRoutes from "./routes/bulk-discount";
import queueRouter from "./routes/queue";
import { logger } from "./utils/logger";

const app = express();
const port = Number(process.env.PORT) || 3001;

// Security and performance middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Add Clerk middleware before routes
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
app.use("/api/jobs", jobsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/agency", agencyRoutes);
app.use("/api/bulk-discounts", bulkDiscountRoutes);
app.use("/api/queue", queueRouter);

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
