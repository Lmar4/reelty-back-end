import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isAuthenticated } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { PrismaClient, SubscriptionTierId } from "@prisma/client";

const router = express.Router();

// Middleware to verify webhook requests
const verifyWebhook = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.REELTY_API_KEY) {
    logger.error("[Users] Invalid API key for webhook request");
    res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
    return;
  }
  next();
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
            subscriptionStatus: "TRIALING", // Default status
            currentTierId: SubscriptionTierId.FREE, // Set initial tier
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

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error("[Users] Error creating user", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: "Invalid user data",
          details: error.errors,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
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

// Get user by ID
const getUser = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const { userId } = req.params;

    if (!userId || typeof userId !== "string") {
      logger.error("[Users] Invalid user ID format", { userId });
      res.status(400).json({
        success: false,
        error: "Invalid user ID format",
      });
      return;
    }

    logger.info("[Users] Fetching user", { userId });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        currentTier: true,
      },
    });

    if (!user) {
      logger.error("[Users] User not found", { userId });
      res.status(404).json({
        success: false,
        error: "User not found",
      });
      return;
    }

    const { password, ...safeUser } = user;

    res.json({
      success: true,
      data: safeUser,
    });
  } catch (error) {
    // Log any errors in detail
    console.error("5. Error in getUser:", error);
    logger.error("[Users] Error fetching user", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.get("/:userId", isAuthenticated, getUser);
router.delete("/:userId", isAuthenticated, deleteUser);

export default router;
