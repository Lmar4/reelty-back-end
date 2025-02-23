import express from "express";
import analyticsRoutes from "./analytics.js";
import assetsRoutes from "./assets.js";
import usersRoutes from "./users.js";
import statsRoutes from "./stats.js";
import bulkDiscountRoutes from "./bulk-discount.js";
import agencyRoutes from "./agency.js";
import subscriptionTiersRoutes from "./subscription-tiers.js";
import templatesRoutes from "./templates.js";

const router = express.Router();

router.use("/analytics", analyticsRoutes);
router.use("/assets", assetsRoutes);
router.use("/users", usersRoutes);
router.use("/stats", statsRoutes);
router.use("/bulk-discounts", bulkDiscountRoutes);
router.use("/agencies", agencyRoutes);
router.use("/subscription-tiers", subscriptionTiersRoutes);
router.use("/templates", templatesRoutes);

export default router;
