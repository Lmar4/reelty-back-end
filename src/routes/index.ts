import express, { Request, Response, NextFunction } from "express";
import usersRouter from "./users";
import listingsRouter from "./listings";
import subscriptionRouter from "./subscription";
import templatesRouter from "./templates";
import storageRouter from "./storage";
import jobRouter from "./job";
import creditsRouter from "./credits";
import paymentRouter from "./payment";
import adminRouter from "./admin";
import { logger } from "../utils/logger";

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
