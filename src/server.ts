import express, { RequestHandler } from "express";
import cors from "cors";
import * as trpcExpress from "@trpc/server/adapters/express";
import { createContext } from "./trpc/types";
import { appRouter } from "./trpc/router";

const app = express();

// CORS middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

// tRPC middleware
const trpcMiddleware = trpcExpress.createExpressMiddleware({
  router: appRouter,
  createContext,
}) as unknown as RequestHandler;

app.use("/api/trpc", trpcMiddleware);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
