import express from "express";
import usersRouter from "./users";
import listingsRouter from "./listings";
import subscriptionRouter from "./subscription";
import templatesRouter from "./templates";
import storageRouter from "./storage";
import jobRouter from "./job";
import creditsRouter from "./credits";
import paymentRouter from "./payment";

const router = express.Router();

// Mount all routes
router.use("/users", usersRouter);
router.use("/listings", listingsRouter);
router.use("/subscription", subscriptionRouter);
router.use("/templates", templatesRouter);
router.use("/storage", storageRouter);
router.use("/jobs", jobRouter);
router.use("/credits", creditsRouter);
router.use("/payment", paymentRouter);

export default router;
