import { SubscriptionTierId } from "@prisma/client";
import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isAuthenticated } from "../middleware/auth.js";
import { createApiResponse } from "../types/api.js";
import { logger } from "../utils/logger.js";
import { checkSubscriptionStatus } from "../controllers/api/stripeWebhook.js";
const router = express.Router();

// Middleware to verify webhook requests
const verifyWebhook = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Check for API key first
  const apiKey = req.headers["x-api-key"];
  if (apiKey === process.env.REELTY_API_KEY) {
    return next();
  }
  
  // If no API key, check for Authorization header (from frontend webhook)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const userId = authHeader.split(' ')[1];
    if (userId) {
      // Store userId for use in the handler
      req.body.id = req.body.id || userId;
      logger.info("[Users] Request authenticated via Authorization header", { userId });
      return next();
    }
  }
  
  // If neither authentication method works, return 401
  logger.error("[Users] Invalid authentication for user creation request", {
    hasApiKey: !!apiKey,
    hasAuthHeader: !!req.headers.authorization,
  });
  res.status(401).json({
    success: false,
    error: "Unauthorized",
  });
};

// Validation schema for user creation
const createUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

// Add this middleware before your routes
router.use((req, res, next) => {
  logger.debug("[Users] Incoming request", {
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: req.body,
    query: req.query,
    params: req.params,
  });
  next();
});

// Create user from Clerk webhook
router.post(
  "/",
  verifyWebhook,
  async (req: express.Request, res: express.Response) => {
    try {
      const data = createUserSchema.parse(req.body);

      logger.info("[Users] Creating/updating user", { userId: data.id });

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { id: data.id },
          update: {
            email: data.email,
            firstName: data.firstName || null,
            lastName: data.lastName || null,
          },
          create: {
            id: data.id,
            email: data.email,
            firstName: data.firstName || null,
            lastName: data.lastName || null,
            password: "", // Empty password since we're using Clerk for auth
            role: "USER", // Default role
            subscriptions: {
              create: {
                tierId: SubscriptionTierId.FREE,
                status: "TRIALING",
              },
            },
          },
        });

        // Create initial listing credit for new user
        if (!req.body.update) {
          // Only for new users, not updates
          await tx.listingCredit.create({
            data: {
              userId: user.id,
              creditsRemaining: 1,
            },
          });
        }

        return user;
      });

      res.status(201).json(createApiResponse(true, result));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json(
            createApiResponse(false, undefined, undefined, "Invalid user data")
          );
        return;
      }

      res
        .status(500)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            error instanceof Error ? error.message : "Failed to create user"
          )
        );
    }
  }
);

// Delete user and all associated data
const deleteUser = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const { userId } = req.params;

    // Verify the user is deleting their own account
    if (req.user?.id !== userId) {
      res.status(403).json({ error: "Unauthorized to delete this account" });
      return;
    }

    // Start a transaction to delete all user data
    await prisma.$transaction(async (tx) => {
      // Delete user's video jobs
      await tx.videoJob.deleteMany({
        where: { userId },
      });

      // Delete user's photos
      await tx.photo.deleteMany({
        where: { userId },
      });

      // Delete user's listings
      await tx.listing.deleteMany({
        where: { userId },
      });

      // Delete user's listing credits
      await tx.listingCredit.deleteMany({
        where: { userId },
      });

      // Delete user's credit logs
      await tx.creditLog.deleteMany({
        where: {
          OR: [{ userId }, { adminId: userId }],
        },
      });

      // Delete user's tier changes
      await tx.tierChange.deleteMany({
        where: {
          OR: [{ userId }, { adminId: userId }],
        },
      });

      // Delete user's search history
      await tx.searchHistory.deleteMany({
        where: { userId },
      });

      // Delete user's error logs
      await tx.errorLog.deleteMany({
        where: { userId },
      });

      // Delete user's temp uploads
      await tx.tempUpload.deleteMany({
        where: { userId },
      });

      // Delete user's subscription logs
      await tx.subscriptionLog.deleteMany({
        where: { userId },
      });

      // Finally, delete the user
      await tx.user.delete({
        where: { id: userId },
      });
    });

    res
      .status(200)
      .json({ message: "User and associated data deleted successfully" });
  } catch (error) {
    console.error("[DELETE_USER]", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
};

// Get user data endpoint
const getUserData = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res
        .status(401)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "User not authenticated"
          )
        );
      return;
    }

    // Check subscription status before returning user data
    await checkSubscriptionStatus(userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        activeSubscription: {
          include: {
            tier: true,
          },
        },
        listingCredits: true,
        listings: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!user) {
      res
        .status(404)
        .json(createApiResponse(false, undefined, undefined, "User not found"));
      return;
    }

    res.status(200).json(createApiResponse(true, user));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json(
          createApiResponse(false, undefined, undefined, "Invalid user data")
        );
      return;
    }

    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to fetch user data"
        )
      );
  }
};

// Route handlers
router.get("/:userId", isAuthenticated, getUserData);
router.delete("/:userId", isAuthenticated, deleteUser);

export default router;
