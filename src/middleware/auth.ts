import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

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

    if (!userId || !sessionId) {
      throw new AuthError(401, "Invalid or missing session");
    }

    return {
      userId,
      sessionId,
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

    // Verify the user exists in our database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new AuthError(401, "User not found");
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
