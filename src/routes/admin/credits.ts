import express, { RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";
import { isAdmin } from "../../middleware/auth.js";
import { logger } from "../../utils/logger.js";
import { z } from "zod";
import { validateRequest } from "../../middleware/validate.js";

const prisma = new PrismaClient();
const router = express.Router();

// Validation schemas
const creditAdjustSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    amount: z.number().refine((val) => val !== 0, {
      message: "Amount cannot be zero",
    }),
    reason: z.string().min(1),
  }),
});

// Ensure admin access only
router.use(isAdmin);

// Get all credit logs with filtering
const getCreditLogs: RequestHandler = async (req, res) => {
  try {
    const { page = "1", limit = "20", userId, startDate, endDate } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where = {
      ...(userId && { userId: userId as string }),
      ...(startDate &&
        endDate && {
          createdAt: {
            gte: new Date(startDate as string),
            lte: new Date(endDate as string),
          },
        }),
    };

    const [creditLogs, total] = await Promise.all([
      prisma.creditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
          admin: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.creditLog.count({ where }),
    ]);

    res.json({
      data: creditLogs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    logger.error("Error fetching credit logs:", error);
    res.status(500).json({ error: "Failed to fetch credit logs" });
  }
};

// Get credit details for a specific user
const getUserCreditDetails: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params;

    const [user, creditLogs, listingCredits] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          currentTier: true,
        },
      }),
      prisma.creditLog.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: {
          admin: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      prisma.listingCredit.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!user) {
      res.status(404).json({ error: `User with ID ${userId} not found` });
      return;
    }

    // Calculate total available credits
    const totalCredits = listingCredits.reduce(
      (sum, credit) => sum + credit.creditsRemaining,
      0
    );

    res.json({
      user,
      creditLogs,
      listingCredits,
      totalCredits,
    });
  } catch (error) {
    logger.error("Error fetching user credit details:", error);
    res.status(500).json({ error: "Failed to fetch user credit details" });
  }
};

// Adjust credits for a user
const adjustUserCredits: RequestHandler = async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    const adminId = req.user?.id; // From auth middleware

    if (!adminId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({ error: `User with ID ${userId} not found` });
      return;
    }

    // Use a transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx) => {
      // Create credit log entry
      const creditLog = await tx.creditLog.create({
        data: {
          userId,
          amount,
          reason,
          adminId,
        },
      });

      // If adding credits, create a new listing credit
      if (amount > 0) {
        await tx.listingCredit.create({
          data: {
            userId,
            creditsRemaining: amount,
          },
        });
      }
      // If removing credits, update existing listing credits
      else if (amount < 0) {
        const absAmount = Math.abs(amount);
        let remainingToRemove = absAmount;

        // Get all listing credits with remaining credits
        const listingCredits = await tx.listingCredit.findMany({
          where: {
            userId,
            creditsRemaining: { gt: 0 },
          },
          orderBy: { createdAt: "asc" }, // Oldest first
        });

        // Calculate total available credits
        const totalAvailable = listingCredits.reduce(
          (sum, credit) => sum + credit.creditsRemaining,
          0
        );

        // Check if user has enough credits
        if (totalAvailable < absAmount) {
          throw new Error(
            `User only has ${totalAvailable} credits available, cannot remove ${absAmount}`
          );
        }

        // Remove credits from listing credits, starting with oldest
        for (const credit of listingCredits) {
          if (remainingToRemove <= 0) break;

          const toRemove = Math.min(credit.creditsRemaining, remainingToRemove);

          await tx.listingCredit.update({
            where: { id: credit.id },
            data: {
              creditsRemaining: credit.creditsRemaining - toRemove,
            },
          });

          remainingToRemove -= toRemove;
        }
      }

      return creditLog;
    });

    res.json(result);
  } catch (error) {
    logger.error("Error adjusting credits:", error);
    res.status(500).json({
      error: "Failed to adjust credits",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Register routes
router.get("/", getCreditLogs);
router.get("/user/:userId", getUserCreditDetails);
router.post("/adjust", validateRequest(creditAdjustSchema), adjustUserCredits);

export default router;
