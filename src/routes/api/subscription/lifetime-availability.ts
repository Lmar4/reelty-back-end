import { Router } from "express";
import { plansService } from "../../../services/stripe/plans.service.js";
import { isAuthenticated } from "../../../middleware/auth.js";

const router = Router();

// GET /api/subscription/lifetime-availability
// Returns availability information for the lifetime plan
router.get("/", isAuthenticated, async (req, res) => {
  try {
    const availability = await plansService.getLifetimePlanAvailability();
    res.json(availability);
  } catch (error) {
    console.error("Error checking lifetime plan availability:", error);
    res.status(500).json({
      error: "Failed to check lifetime plan availability",
    });
  }
});

export default router;
