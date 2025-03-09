import { PrismaClient, SubscriptionStatus, UserRole } from "@prisma/client";
import { Request, Response, Router } from "express";
import { validateRequest } from "../middleware/validate.js";
import {
  CreateUserInput,
  UpdateUserInput,
  UserListResponse,
  UserResponse,
  createUserSchema,
  updateUserSchema,
} from "../models/user.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

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
      // Create the user first
      const user = await prisma.user.create({
        data: {
          ...userData,
          password: userData.password || "",
          role: UserRole.USER,
          notificationProductUpdates: true,
          notificationReelsReady: true,
        },
      });

      // Create a trial subscription for the new user
      const defaultTier = await prisma.subscriptionTier.findFirst({
        where: { name: "Free" }, // Assuming there's a free tier
      });

      const subscription = await prisma.subscription.create({
        data: {
          userId: user.id,
          tierId: defaultTier?.id || "", // Use the free tier or empty string if not found
          status: "TRIALING", // Using string literal instead of enum
        },
        include: {
          tier: true,
        },
      });

      // Construct response according to our UserResponse interface
      const response: UserResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        timeZone: null,
        notificationSettings: {
          productUpdates: user.notificationProductUpdates,
          reelsReady: user.notificationReelsReady,
        },
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        subscription: user.activeSubscriptionId
          ? {
              id: user.activeSubscriptionId,
              userId: user.id,
              tierId: subscription?.tier?.tierId || "",
              tierName: subscription?.tier?.name || null,
              status: subscription?.status || "INACTIVE",
              stripeCustomerId: subscription?.stripeCustomerId || null,
              stripeSubscriptionId: subscription?.stripeSubscriptionId || null,
              stripePriceId: subscription?.stripePriceId || null,
              billingEmail: user.email,
              autoRenew: true,
              currentPeriodStart: subscription?.startDate || user.createdAt,
              currentPeriodEnd: subscription?.currentPeriodEnd || null,
              canceledAt: subscription?.canceledAt || null,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
              usageRecords: [],
              billingRecords: [],
            }
          : null,
        credits: {
          balance: 0, // This would need to be calculated from actual credit records
          totalAllocated: 0,
          totalUsed: 0,
        },
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
      const { firstName, lastName, notificationSettings } = req.body;

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          firstName,
          lastName,
          notificationProductUpdates: notificationSettings?.productUpdates,
          notificationReelsReady: notificationSettings?.reelsReady,
        },
        include: {
          activeSubscription: {
            include: {
              tier: true,
            },
          },
        },
      });

      const response: UserResponse = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        timeZone: user.timeZone,
        notificationSettings: {
          productUpdates: user.notificationProductUpdates,
          reelsReady: user.notificationReelsReady,
        },
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        subscription: user.activeSubscription
          ? {
              id: user.activeSubscription.id,
              userId: user.id,
              tierId: user.activeSubscription.tierId,
              tierName: user.activeSubscription.tier?.name || null,
              status: user.activeSubscription.status,
              stripeCustomerId: user.activeSubscription.stripeCustomerId,
              stripeSubscriptionId:
                user.activeSubscription.stripeSubscriptionId,
              stripePriceId: user.activeSubscription.stripePriceId,
              billingEmail: user.email,
              autoRenew: true,
              currentPeriodStart: user.activeSubscription.startDate,
              currentPeriodEnd:
                user.activeSubscription.currentPeriodEnd || null,
              canceledAt: user.activeSubscription.canceledAt,
              createdAt: user.activeSubscription.createdAt,
              updatedAt: user.activeSubscription.updatedAt,
              usageRecords: [],
              billingRecords: [],
            }
          : null,
        credits: {
          balance: user.activeSubscription?.creditsBalance || 0,
          totalAllocated: user.activeSubscription?.creditsPerPeriod || 0,
          totalUsed: 0, // This would need to be calculated from actual credit records
        },
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
        subscriptions: {
          include: {
            tier: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
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
      role: user.role,
      timeZone: null,
      notificationSettings: {
        productUpdates: user.notificationProductUpdates,
        reelsReady: user.notificationReelsReady,
      },
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      subscription:
        user.activeSubscriptionId && user.subscriptions?.[0]
          ? {
              id: user.activeSubscriptionId,
              userId: user.id,
              tierId: user.subscriptions[0].tier?.tierId || "",
              tierName: user.subscriptions[0].tier?.name || null,
              status: user.subscriptions[0].status || "INACTIVE",
              billingEmail: user.email,
              autoRenew: true,
              currentPeriodStart:
                user.subscriptions[0].startDate || user.createdAt,
              currentPeriodEnd: user.subscriptions[0].currentPeriodEnd || null,
              canceledAt: user.subscriptions[0].canceledAt || null,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
              usageRecords: [],
              billingRecords: [],
              stripeCustomerId: "",
              stripeSubscriptionId: "",
              stripePriceId: "",
            }
          : null,
      credits: {
        balance: 0, // This would need to be calculated from actual credit records
        totalAllocated: 0,
        totalUsed: 0,
      },
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
          activeSubscription: {
            include: {
              tier: true,
            },
          },
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
        role: user.role,
        timeZone: null,
        notificationSettings: {
          productUpdates: user.notificationProductUpdates,
          reelsReady: user.notificationReelsReady,
        },
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        subscription: user.activeSubscriptionId
          ? {
              id: user.activeSubscriptionId,
              userId: user.id,
              tierId: user.activeSubscription?.tier?.tierId || "",
              tierName: user.activeSubscription?.tier?.name || null,
              status: user.activeSubscription?.status || "INACTIVE",
              stripeCustomerId:
                user.activeSubscription?.stripeCustomerId || null,
              stripeSubscriptionId:
                user.activeSubscription?.stripeSubscriptionId || null,
              stripePriceId: user.activeSubscription?.stripePriceId || null,
              billingEmail: user.email,
              autoRenew: true,
              currentPeriodStart:
                user.activeSubscription?.startDate || user.createdAt,
              currentPeriodEnd:
                user.activeSubscription?.currentPeriodEnd || null,
              canceledAt: user.activeSubscription?.canceledAt || null,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
              usageRecords: [],
              billingRecords: [],
            }
          : null,
        credits: {
          balance: 0, // This would need to be calculated from actual credit records
          totalAllocated: 0,
          totalUsed: 0,
        },
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

// Get user profile
router.get("/profile", async (req: Request, res: Response) => {
  try {
    const user: any = req.user;

    if (!user) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const userWithSubscription = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        activeSubscription: {
          include: {
            tier: true,
          },
        },
      },
    });

    if (!userWithSubscription) {
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    const response: UserResponse = {
      id: userWithSubscription.id,
      email: userWithSubscription.email,
      firstName: userWithSubscription.firstName,
      lastName: userWithSubscription.lastName,
      role: userWithSubscription.role,
      timeZone: userWithSubscription.timeZone,
      notificationSettings: {
        productUpdates: userWithSubscription.notificationProductUpdates,
        reelsReady: userWithSubscription.notificationReelsReady,
      },
      lastLoginAt: userWithSubscription.lastLoginAt,
      createdAt: userWithSubscription.createdAt,
      updatedAt: userWithSubscription.updatedAt,
      subscription: userWithSubscription.activeSubscription
        ? {
            id: userWithSubscription.activeSubscription.id,
            userId: userWithSubscription.id,
            tierId: userWithSubscription.activeSubscription.tierId,
            tierName:
              userWithSubscription.activeSubscription.tier?.name || null,
            status: userWithSubscription.activeSubscription.status,
            stripeCustomerId:
              userWithSubscription.activeSubscription.stripeCustomerId,
            stripeSubscriptionId:
              userWithSubscription.activeSubscription.stripeSubscriptionId,
            stripePriceId:
              userWithSubscription.activeSubscription.stripePriceId,
            billingEmail: userWithSubscription.email,
            autoRenew: true,
            currentPeriodStart:
              userWithSubscription.activeSubscription.startDate,
            currentPeriodEnd:
              userWithSubscription.activeSubscription.currentPeriodEnd || null,
            canceledAt: userWithSubscription.activeSubscription.canceledAt,
            createdAt: userWithSubscription.activeSubscription.createdAt,
            updatedAt: userWithSubscription.activeSubscription.updatedAt,
            usageRecords: [],
            billingRecords: [],
          }
        : null,
      credits: {
        balance: userWithSubscription.activeSubscription?.creditsBalance || 0,
        totalAllocated:
          userWithSubscription.activeSubscription?.creditsPerPeriod || 0,
        totalUsed: 0, // This would need to be calculated from actual credit records
      },
    };

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error("Get user profile error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// Get current user
router.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        activeSubscription: {
          include: {
            tier: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      timeZone: null,
      notificationSettings: {
        productUpdates: user.notificationProductUpdates,
        reelsReady: user.notificationReelsReady,
      },
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      subscription: user.activeSubscription
        ? {
            id: user.activeSubscription.id,
            userId: user.id,
            tierId: user.activeSubscription.tierId,
            tierName: user.activeSubscription.tier?.name || null,
            status: user.activeSubscription.status,
            stripeCustomerId: null, // No longer used in new schema
            stripeSubscriptionId: null, // No longer used in new schema
            stripePriceId: null, // No longer used in new schema
            billingEmail: user.email,
            autoRenew: true,
            currentPeriodStart:
              user.activeSubscription.startDate || user.createdAt,
            currentPeriodEnd: user.activeSubscription.currentPeriodEnd || null,
            canceledAt: user.activeSubscription.canceledAt || null,
            createdAt: user.activeSubscription.createdAt,
            updatedAt: user.activeSubscription.updatedAt,
            usageRecords: [],
            billingRecords: [],
          }
        : null,
      credits: {
        balance: 0,
        totalAllocated: 0,
        totalUsed: 0,
      },
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to get user" });
  }
});

export default router;
