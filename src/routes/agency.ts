import express from "express";
import { z } from "zod";
import { AgencyService } from "../services/agency.service.js";
import { validateRequest } from "../middleware/validate.js";
import { isAuthenticated } from "../middleware/auth.js";
import { isAgencyOwner } from "../middleware/roles.js";
import { createApiResponse } from "../types/api.js";
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
      res.json(createApiResponse(true, agency));
    } catch (error) {
      res
        .status(500)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            error instanceof Error ? error.message : "Failed to create agency"
          )
        );
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
      const agencyUser = await agencyService.addUserToAgency(
        req.user!.id,
        req.body.userId
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
      await agencyService.removeUserFromAgency(req.body.userId);
      res.json(createApiResponse(true, undefined, "User removed from agency"));
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
    const agency = await agencyService.getAgencies();
    const stats = {
      totalUsers: agency[0]?.agencyCurrentUsers || 0,
      maxUsers: agency[0]?.agencyMaxUsers || 0,
    };
    res.json(createApiResponse(true, stats));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to get agency stats"
        )
      );
  }
});

export default router;
