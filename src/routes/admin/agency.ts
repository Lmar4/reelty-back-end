import express from "express";
import { z } from "zod";
import { AgencyService } from "../../services/agency.service.js";
import { validateRequest } from "../../middleware/validate.js";
import { isAdmin as requireAdmin } from "../../middleware/auth.js";

const router = express.Router();
const agencyService = new AgencyService();

// Validation schemas
const createAgencySchema = z.object({
  body: z.object({
    name: z.string().min(3),
    maxUsers: z.number().min(1),
    ownerId: z.string().uuid(),
  }),
});

const addUserSchema = z.object({
  body: z.object({
    agencyId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
});

// Apply admin middleware to all routes
router.use(requireAdmin);

// Get all agencies
router.get("/", async (_req, res) => {
  try {
    const agencies = await agencyService.getAgencies();
    res.json({
      success: true,
      data: agencies,
    });
  } catch (error) {
    console.error("Get agencies error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// Create new agency
router.post(
  "/",
  validateRequest(createAgencySchema),
  async (req, res) => {
    try {
      const agency = await agencyService.createAgency(req.body);
      res.json({
        success: true,
        data: agency,
      });
    } catch (error) {
      console.error("Create agency error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Add user to agency
router.post(
  "/agencies/add-user",
  validateRequest(addUserSchema),
  async (req, res) => {
    try {
      const { agencyId, userId } = req.body;
      const updatedAgency = await agencyService.addUserToAgency(agencyId, userId);
      res.json({
        success: true,
        data: updatedAgency,
      });
    } catch (error) {
      console.error("Add user to agency error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

export default router;
