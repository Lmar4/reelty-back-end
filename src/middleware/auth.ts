import { TRPCError } from "@trpc/server";
import { getAuth } from "@clerk/express";
import type { Request } from "express";

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY environment variable");
}

export async function validateRequest(req: Request) {
  try {
    // Ensure clerkMiddleware has run and auth is attached to the request
    const auth = getAuth(req);

    if (!auth.sessionId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid or missing session",
      });
    }

    return {
      userId: auth.userId,
      sessionId: auth.sessionId,
    };
  } catch (error) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication failed",
      cause: error,
    });
  }
}
