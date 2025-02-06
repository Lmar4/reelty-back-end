import express, { RequestHandler } from "express";
import cors from "cors";
import * as trpcExpress from "@trpc/server/adapters/express";
import { createContext } from "./trpc/types";
import { getAppRouter } from "./trpc/router";

const app = express();

// CORS middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

// // Middleware to handle API Gateway stage prefix
// app.use((req, res, next) => {
//   const stagePrefix = "/prod"; // Change this according to your stage name
//   if (req.path.startsWith(stagePrefix)) {
//     req.url = req.url.substring(stagePrefix.length);
//   }
//   next();
// });

// Initialize the server asynchronously
const initializeServer = async () => {
  const appRouter = await getAppRouter();

  // tRPC middleware
  const trpcMiddleware = trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  }) as unknown as RequestHandler;

  app.use("/api/trpc", trpcMiddleware);

  const port = process.env.PORT || 8081;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
};

// Start the server
initializeServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
