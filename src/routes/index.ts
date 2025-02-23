import express, { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";
import creditsRouter from "./credits.js";
import jobRouter from "./job.js";
import listingsRouter from "./listings.js";
import paymentRouter from "./payment.js";
import storageRouter from "./storage.js";
import subscriptionRouter from "./subscription.js";
import templatesRouter from "./templates.js";
import usersRouter from "./users.js";

const router = express.Router();

// Debug middleware for base router
router.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info("[Base Router] Handling request", {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    body: req.body,
    headers: {
      authorization: req.headers.authorization ? "present" : "missing",
    },
  });
  next();
});

// Mount all routes with explicit paths and add logging
router.use(
  "/listings",
  (req: Request, _res: Response, next: NextFunction) => {
    logger.info("[Listings Router] Request received", {
      method: req.method,
      path: req.path,
      body: req.body,
    });
    next();
  },
  listingsRouter
);

// Mount other routes
router.use("/users", usersRouter);
router.use("/subscription", subscriptionRouter);
router.use("/templates", templatesRouter);
router.use("/storage", storageRouter);
router.use("/jobs", jobRouter);
router.use("/credits", creditsRouter);
router.use("/payment", paymentRouter);

export default router;

export { listingsRouter };
