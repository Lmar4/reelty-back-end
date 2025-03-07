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

    // Enhanced logging with token details
    const authHeader = req.headers.authorization;
    const tokenPrefix =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.substring(7, 17) + "..."
        : "missing";

    logger.info(`[Auth] Validating request`, {
      userId,
      sessionId: sessionId ? "present" : "missing",
      headers: {
        authorization: tokenPrefix,
        host: req.headers.host,
        origin: req.headers.origin,
      },
      url: req.url,
      method: req.method,
    });

    if (!userId || !sessionId) {
      // More detailed logging for auth failures
      logger.warn(`[Auth] Invalid or missing session`, {
        userId,
        sessionId,
        authHeaderPresent: !!req.headers.authorization,
        authHeaderPrefix: tokenPrefix,
        // Log additional request details that might help diagnose the issue
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      throw new AuthError(401, "Invalid or missing session");
    }

    return {
      userId,
      sessionId,
    };
  } catch (error) {
    // Enhanced error logging
    logger.error(`[Auth] Authentication error`, {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      headers: {
        authorization: req.headers.authorization ? "present" : "missing",
        host: req.headers.host,
        origin: req.headers.origin,
      },
      url: req.url,
      method: req.method,
      ip: req.ip,
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

        // Log the attempt with detailed information
        logger.info(`Attempting to create user ${userId}`, {
          userId,
          email: email || "No email found in session claims",
          sessionClaims: auth.sessionClaims,
        });

        if (!email) {
          logger.error(`No email found for user ${userId} in session claims`);
          throw new Error("No email found in session claims");
        }

        // First check if the FREE tier exists
        const freeTier = await prisma.subscriptionTier.findUnique({
          where: { tierId: "FREE" },
        });

        if (!freeTier) {
          logger.error(
            `Free tier not found in database, attempting to create user without tier reference`
          );

          // Create the user without tier reference as a fallback
          try {
            user = await prisma.user.create({
              data: {
                id: userId,
                email: email,
                firstName: null,
                lastName: null,
                password: "", // Empty password since we're using Clerk for auth
                role: "USER", // Default role
                subscriptionStatus: "TRIALING", // Default status
                // Skip currentTierId since the tier doesn't exist
              },
            });

            logger.info(
              `Successfully created user ${userId} in database without tier reference`
            );

            // Create initial listing credit for new user
            await prisma.listingCredit.create({
              data: {
                userId: user.id,
                creditsRemaining: 1, // Default to 1 since we don't have tier info
              },
            });

            logger.info(
              `Successfully created listing credit for user ${userId}`
            );

            // Continue with the request
            req.user = { id: userId };
            next();
            return; // Exit early since we've already called next()
          } catch (fallbackError) {
            logger.error(`Fallback user creation failed for ${userId}`, {
              error:
                fallbackError instanceof Error
                  ? fallbackError.message
                  : "Unknown error",
              stack:
                fallbackError instanceof Error
                  ? fallbackError.stack
                  : undefined,
            });
            throw new Error("Free tier not found and fallback creation failed");
          }
        }

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
            currentTierId: SubscriptionTierId.FREE, // Use the enum value instead of string
          },
        });

        logger.info(`Successfully created user ${userId} in database`);

        // Create initial listing credit for new user
        await prisma.listingCredit.create({
          data: {
            userId: user.id,
            creditsRemaining: freeTier.creditsPerInterval || 1,
          },
        });

        logger.info(`Successfully created listing credit for user ${userId}`);
      } catch (createError) {
        logger.error(`Failed to create user ${userId} in database`, {
          error:
            createError instanceof Error
              ? createError.message
              : "Unknown error",
          stack: createError instanceof Error ? createError.stack : undefined,
        });

        // EMERGENCY FALLBACK: Allow the request to proceed even if user creation fails
        // This is a temporary measure to prevent blocking users in production
        logger.warn(
          `EMERGENCY FALLBACK: Allowing request to proceed for user ${userId} despite creation failure`
        );
        req.user = { id: userId };
        next();
        return; // Exit early since we've already called next()
      }
    }

    req.user = { id: userId };
    next();
  } catch (error) {
    logger.error(`Authentication error in isAuthenticated middleware`, {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

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
