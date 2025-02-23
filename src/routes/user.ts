import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import {
  CreateUserInput,
  UpdateUserInput,
  UserResponse,
  UserListResponse,
  createUserSchema,
  updateUserSchema,
} from "../models/user.js";
import { validateRequest } from "../middleware/validate.js";

const router = Router();
const prisma = new PrismaClient();

interface TypedRequest<T> extends Request {
  body: T;
}

// Create user
router.post(
  "/",
  validateRequest(createUserSchema),
  async (req: TypedRequest<CreateUserInput>, res: Response) => {
    try {
      const userData = req.body;
      const user = await prisma.user.create({
        data: userData,
        include: {
          currentTier: true,
        },
      });

      const response: UserResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        stripePriceId: user.stripePriceId,
        stripeProductId: user.stripeProductId,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionPeriodEnd: user.subscriptionPeriodEnd,
        currentTierId: user.currentTierId,
        currentTier: user.currentTier,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

      res.status(201).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("Create user error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Update user
router.put(
  "/:userId",
  validateRequest(updateUserSchema),
  async (req: TypedRequest<UpdateUserInput>, res: Response) => {
    try {
      const { userId } = req.params;
      const userData = req.body;

      const user = await prisma.user.update({
        where: { id: userId },
        data: userData,
        include: {
          currentTier: true,
        },
      });

      const response: UserResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        stripePriceId: user.stripePriceId,
        stripeProductId: user.stripeProductId,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionPeriodEnd: user.subscriptionPeriodEnd,
        currentTierId: user.currentTierId,
        currentTier: user.currentTier,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("Update user error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Get user
router.get("/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        currentTier: true,
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    const response: UserResponse = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
      stripePriceId: user.stripePriceId,
      stripeProductId: user.stripeProductId,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionPeriodEnd: user.subscriptionPeriodEnd,
      currentTierId: user.currentTierId,
      currentTier: user.currentTier,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// List users
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          currentTier: true,
        },
      }),
      prisma.user.count(),
    ]);

    const response: UserListResponse = {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        stripePriceId: user.stripePriceId,
        stripeProductId: user.stripeProductId,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionPeriodEnd: user.subscriptionPeriodEnd,
        currentTierId: user.currentTierId,
        currentTier: user.currentTier,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
      total,
      page,
      limit,
    };

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

export default router;
