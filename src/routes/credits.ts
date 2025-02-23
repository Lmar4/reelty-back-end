import { Router } from "express";
import {
  checkCredits,
  deductCredits,
  getCreditHistory,
  purchaseCredits,
  getBalance,
} from "../controllers/api/credits.js";
import { isAuthenticated } from "../middleware/auth.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";

const router = Router();

// Validation schemas
const deductCreditsSchema = z.object({
  body: z.object({
    amount: z.number().min(1),
    reason: z.string().min(1),
  }),
});

const purchaseCreditsSchema = z.object({
  body: z.object({
    amount: z.number().min(1),
    paymentMethodId: z.string().optional(),
  }),
});

// Credit management routes
router.get("/balance", isAuthenticated, getBalance);
router.post("/check", isAuthenticated, checkCredits);
router.post(
  "/deduct",
  isAuthenticated,
  validateRequest(deductCreditsSchema),
  deductCredits
);
router.get("/history/:userId", isAuthenticated, getCreditHistory);
router.post(
  "/purchase",
  isAuthenticated,
  validateRequest(purchaseCreditsSchema),
  purchaseCredits
);

export default router;
