import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { SubscriptionTierId } from "@prisma/client";

// Extend Request type to include user property
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role?: string;
      };
    }
  }
}

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY environment variable");
}

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export async function validateRequest(req: Request) {
  try {
    const auth = getAuth(req);
    const { userId, sessionId } = auth;

    logger.info(`[Auth] Validating request`, {
      userId,
      sessionId: sessionId ? "present" : "missing",
      headers: {
        authorization: req.headers.authorization ? "present" : "missing",
        host: req.headers.host,
        origin: req.headers.origin,
      },
      url: req.url,
      method: req.method,
    });

    if (!userId || !sessionId) {
      logger.warn(`[Auth] Invalid or missing session`, {
        userId,
        sessionId,
      });
      throw new AuthError(401, "Invalid or missing session");
    }

    return {
      userId,
      sessionId,
    };
  } catch (error) {
    logger.error(`[Auth] Authentication error`, {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      headers: {
        authorization: req.headers.authorization ? "present" : "missing",
      },
    });

    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(401, "Authentication failed");
  }
}

export async function isAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId } = await validateRequest(req);

    // Verify the user exists in our database
    let user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    // If user doesn't exist but has valid Clerk token, create the user
    if (!user) {
      logger.info(
        `User ${userId} not found in database but has valid Clerk token. Creating user.`
      );

      try {
        // Get user details from Clerk if possible
        const auth = getAuth(req);
        const email = (auth.sessionClaims?.email as string) || "";

        // Create the user with minimal information
        user = await prisma.user.create({
          data: {
            id: userId,
            email: email,
            firstName: null,
            lastName: null,
            password: "", // Empty password since we're using Clerk for auth
            role: "USER", // Default role
            subscriptionStatus: "TRIALING", // Default status
            currentTierId: SubscriptionTierId.FREE, // Set initial tier
          },
        });

        // Create initial listing credit for new user
        await prisma.listingCredit.create({
          data: {
            userId: user.id,
            creditsRemaining: 1,
          },
        });

        logger.info(`Successfully created user ${userId} in database`);
      } catch (createError) {
        logger.error(
          `Failed to create user ${userId} in database`,
          createError
        );
        throw new AuthError(401, "User not found and could not be created");
      }
    }

    req.user = { id: userId };
    next();
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(401).json({ error: "Authentication failed" });
    }
  }
}

export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = await validateRequest(req);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user?.role || user.role !== "ADMIN") {
      throw new AuthError(403, "Unauthorized: Admin access required");
    }

    req.user = { id: userId, role: user.role };
    next();
  } catch (error) {
    console.error("[isAdmin] Error:", error);
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(403).json({ error: "Unauthorized: Admin access required" });
    }
  }
}
