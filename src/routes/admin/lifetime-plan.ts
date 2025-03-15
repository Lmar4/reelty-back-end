import express, { RequestHandler } from "express";
import { getLifetimePlanStats } from "../../controllers/api/admin/lifetime-plan.js";
import { isAdmin } from "../../middleware/auth.js";

const router = express.Router();

// Apply admin middleware to all routes
router.use(isAdmin);

// Wrap the controller function to match the RequestHandler return type
const getLifetimePlanStatsHandler: RequestHandler = async (req, res, next) => {
  try {
    await getLifetimePlanStats(req, res);
  } catch (error) {
    next(error);
  }
};

// Get lifetime plan statistics
router.get("/stats", getLifetimePlanStatsHandler);

export default router;
