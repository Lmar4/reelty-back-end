import express from "express";
import { z } from "zod";
import { BulkDiscountService } from "../services/bulk-discount.service";
import { validateRequest } from "../middleware/validate";
import { isAuthenticated } from "../middleware/auth";
import { isAdmin } from "../middleware/roles";

const router = express.Router();
const bulkDiscountService = new BulkDiscountService();

// Validation schemas
const createDiscountSchema = z.object({
  body: z.object({
    name: z.string().min(3),
    description: z.string().min(10),
    discountPercent: z.number().min(1).max(100),
    maxUsers: z.number().min(1),
    expiresAt: z.string().datetime().optional(),
  }),
});

const applyDiscountSchema = z.object({
  body: z.object({
    discountId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
});

// Create new bulk discount
router.post(
  "/create",
  isAuthenticated,
  isAdmin,
  validateRequest(createDiscountSchema),
  async (req, res) => {
    try {
      const discount = await bulkDiscountService.createBulkDiscount(req.body);
      res.json({
        success: true,
        data: discount,
      });
    } catch (error) {
      console.error("Create bulk discount error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Get all active bulk discounts
router.get("/", isAuthenticated, isAdmin, async (_req, res) => {
  try {
    const discounts = await bulkDiscountService.getBulkDiscounts();
    res.json({
      success: true,
      data: discounts,
    });
  } catch (error) {
    console.error("Get bulk discounts error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// Apply bulk discount to user
router.post(
  "/apply",
  isAuthenticated,
  isAdmin,
  validateRequest(applyDiscountSchema),
  async (req, res) => {
    try {
      const { discountId, userId } = req.body;
      const updatedUser = await bulkDiscountService.applyBulkDiscount(
        discountId,
        userId
      );
      res.json({
        success: true,
        data: updatedUser,
      });
    } catch (error) {
      console.error("Apply bulk discount error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Deactivate bulk discount
router.post("/deactivate/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await bulkDiscountService.deactivateDiscount(id);
    res.json({
      success: true,
    });
  } catch (error) {
    console.error("Deactivate bulk discount error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// Get bulk discount stats
router.get("/stats/:id", isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await bulkDiscountService.getDiscountStats(id);
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Get bulk discount stats error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

export default router;
