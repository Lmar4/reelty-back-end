import { PrismaClient } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isAdmin as requireAdmin } from "../../middleware/auth";
import { validateRequest } from "../../middleware/validate";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const creditAdjustmentSchema = z.object({
  body: z.object({
    amount: z.number(),
    reason: z.string().min(1),
  }),
});

const statusUpdateSchema = z.object({
  body: z.object({
    status: z.enum([
      "ACTIVE",
      "CANCELED",
      "INCOMPLETE",
      "INCOMPLETE_EXPIRED",
      "PAST_DUE",
      "TRIALING",
      "UNPAID",
      "INACTIVE",
    ]),
  }),
});

// User handlers
const listUsers: RequestHandler = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        currentTier: true,
        subscriptionLogs: true,
      },
    });

    res.json({
      success: true,
      data: users,
    });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

const adjustUserCredits: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    // Create credit adjustment log
    await prisma.creditLog.create({
      data: {
        userId,
        amount,
        reason,
        adminId: req.user?.id,
      },
    });

    res.json({
      success: true,
      data: null,
    });
  } catch (error) {
    console.error("Adjust credits error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

const updateUserStatus: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: status,
      },
      include: {
        currentTier: true,
        subscriptionLogs: true,
      },
    });

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error("Update status error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Record to update not found")
    ) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Apply admin middleware to all routes
router.use(requireAdmin);

// Register routes
router.get("/", listUsers);
router.post(
  "/:userId/credits",
  validateRequest(creditAdjustmentSchema),
  adjustUserCredits
);
router.patch(
  "/:userId/status",
  validateRequest(statusUpdateSchema),
  updateUserStatus
);

export default router;
