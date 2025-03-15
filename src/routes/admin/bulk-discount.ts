import express from "express";
import { z } from "zod";
import { BulkDiscountService } from "../../services/bulk-discount.service.js";
import { validateRequest } from "../../middleware/validate.js";
import { isAdmin } from "../../middleware/auth.js";

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

// Apply admin middleware to all routes
router.use(isAdmin);

// Get all bulk discounts
router.get("/", async (_req, res) => {
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

// Create new bulk discount
router.post(
  "/",
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
        error: error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Apply bulk discount to user
router.post(
  "/apply",
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
        error: error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Deactivate bulk discount
router.post("/bulk-discounts/:id/deactivate", async (req, res) => {
  try {
    const { id } = req.params;
    const discount = await bulkDiscountService.deactivateDiscount(id);
    res.json({
      success: true,
      data: discount,
    });
  } catch (error) {
    console.error("Deactivate bulk discount error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

export default router;
