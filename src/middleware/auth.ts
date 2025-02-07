import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { SUBSCRIPTION_TIERS } from "../constants/subscription-tiers";

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
    // Ensure clerkMiddleware has run and auth is attached to the request
    const auth = getAuth(req);

    if (!auth.sessionId) {
      throw new AuthError(401, "Invalid or missing session");
    }

    return {
      userId: auth.userId,
      sessionId: auth.sessionId,
    };
  } catch (error) {
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
      select: { currentTierId: true },
    });

    if (
      !user?.currentTierId ||
      user.currentTierId !== SUBSCRIPTION_TIERS.ADMIN
    ) {
      throw new AuthError(403, "Unauthorized: Admin access required");
    }

    req.user = { id: userId, role: "ADMIN" };
    next();
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(403).json({ error: "Unauthorized: Admin access required" });
    }
  }
}
