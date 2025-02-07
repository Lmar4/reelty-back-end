import express, { RequestHandler } from "express";
import cors from "cors";
import * as trpcExpress from "@trpc/server/adapters/express";
import { createContext } from "./trpc/types";
import { getAppRouter } from "./trpc/router";
import { clerkMiddleware } from "@clerk/express";

const app = express();

// Apply CORS middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Apply Clerk middleware for authentication
app.use(clerkMiddleware());

// Initialize the server asynchronously
const initializeServer = async () => {
  const appRouter = await getAppRouter();

  // Apply tRPC middleware
  const trpcMiddleware = trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  }) as unknown as RequestHandler;

  // Set up the tRPC route
  app.use("/api/trpc", trpcMiddleware);

  // Start the server
  const port = process.env.PORT || 8081;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
};

// Start the server and handle any initialization errors
initializeServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
