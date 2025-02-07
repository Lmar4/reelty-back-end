import { getAuth } from "@clerk/express";
import type { Request } from "express";

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
