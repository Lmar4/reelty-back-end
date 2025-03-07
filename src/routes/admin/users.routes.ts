import { PrismaClient, Prisma } from "@prisma/client";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { isAdmin, isAuthenticated } from "../../middleware/auth.js";
import { validateRequest } from "../../middleware/validate.js";
import { userCreditsService } from "../../services/admin/user-credits.service.js";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const userCreditsSchema = z.object({
  body: z.object({
    amount: z.number(),
    reason: z.string().optional(),
  }),
});

// Apply admin middleware to all routes
router.use(isAdmin);

// User credit handlers
const manageUserCredits = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Unauthorized - Admin ID not found",
      });
      return;
    }

    const adminId = req.user.id;

    if (!amount) {
      res.status(400).json({
        success: false,
        message: "Credit amount is required",
      });
      return;
    }

    let result;
    if (amount > 0) {
      result = await userCreditsService.addCreditsToUser(
        userId,
        amount,
        adminId,
        reason || "Admin adjustment"
      );
    } else {
      result = await userCreditsService.removeCreditsFromUser(
        userId,
        Math.abs(amount),
        adminId,
        reason || "Admin adjustment"
      );
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error managing user credits:", error);
    res.status(500).json({
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get users handler
const getUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Extract query parameters for filtering/pagination if needed
    const { page = 1, limit = 20, search } = req.query;

    // Build the query
    const where: Prisma.UserWhereInput = {};

    if (search && typeof search === "string") {
      where.OR = [
        {
          email: { contains: search, mode: "insensitive" as Prisma.QueryMode },
        },
        {
          firstName: {
            contains: search,
            mode: "insensitive" as Prisma.QueryMode,
          },
        },
        {
          lastName: {
            contains: search,
            mode: "insensitive" as Prisma.QueryMode,
          },
        },
      ];
    }

    // Get users with pagination
    const users = await prisma.user.findMany({
      where,
      include: {
        currentTier: true,
        listingCredits: true,
      },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Transform the data to match the AdminUser type expected by the frontend
    const transformedUsers = users.map((user) => ({
      ...user,
      credits: user.listingCredits?.[0]?.creditsRemaining || 0,
    }));

    res.json({
      success: true,
      data: {
        data: transformedUsers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get single user handler
const getUserById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        currentTier: true,
        listingCredits: true,
        subscriptionHistory: {
          include: {
            tier: true,
          },
          orderBy: {
            startDate: "desc",
          },
        },
        creditLogs: {
          orderBy: {
            createdAt: "desc",
          },
          take: 10,
        },
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    res.json({
      success: true,
      data: {
        ...user,
        credits: user.listingCredits?.[0]?.creditsRemaining || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Register routes
router.get("/", getUsers);
router.get("/:userId", getUserById);
router.post(
  "/:userId/credits",
  validateRequest(userCreditsSchema),
  manageUserCredits
);

export default router;
