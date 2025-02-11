import express from "express";
import { z } from "zod";
import { AgencyService } from "../services/agency.service";
import { validateRequest } from "../middleware/validate";
import { isAuthenticated } from "../middleware/auth";
import { isAgencyOwner } from "../middleware/roles";

const router = express.Router();
const agencyService = new AgencyService();

// Validation schemas
const createAgencySchema = z.object({
  body: z.object({
    name: z.string().min(3),
    ownerEmail: z.string().email(),
    maxUsers: z.number().min(1).max(100),
    initialCredits: z.number().min(0),
  }),
});

const addUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    credits: z.number().min(0).optional(),
  }),
});

const removeUserSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
  }),
});

// Create new agency
router.post(
  "/create",
  isAuthenticated,
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
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Add user to agency
router.post(
  "/users",
  isAuthenticated,
  isAgencyOwner,
  validateRequest(addUserSchema),
  async (req, res) => {
    try {
      const agencyUser = await agencyService.addAgencyUser(
        req.user!.id,
        req.body
      );
      res.json({
        success: true,
        data: agencyUser,
      });
    } catch (error) {
      console.error("Add agency user error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Remove user from agency
router.delete(
  "/users",
  isAuthenticated,
  isAgencyOwner,
  validateRequest(removeUserSchema),
  async (req, res) => {
    try {
      await agencyService.removeAgencyUser(req.user!.id, req.body.userId);
      res.json({
        success: true,
      });
    } catch (error) {
      console.error("Remove agency user error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Get agency stats
router.get("/stats", isAuthenticated, isAgencyOwner, async (req, res) => {
  try {
    const stats = await agencyService.getAgencyStats(req.user!.id);
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Get agency stats error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

export default router;
