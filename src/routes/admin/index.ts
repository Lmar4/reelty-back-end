import express from "express";
import analyticsRoutes from "./analytics";
import assetsRoutes from "./assets";
import usersRoutes from "./users";
import statsRoutes from "./stats";
import bulkDiscountRoutes from "./bulk-discount";
import agencyRoutes from "./agency";
import subscriptionTiersRoutes from "./subscription-tiers";

const router = express.Router();

router.use("/analytics", analyticsRoutes);
router.use("/assets", assetsRoutes);
router.use("/users", usersRoutes);
router.use("/stats", statsRoutes);
router.use("/bulk-discounts", bulkDiscountRoutes);
router.use("/agencies", agencyRoutes);
router.use("/subscription-tiers", subscriptionTiersRoutes);

export default router;
