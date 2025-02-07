import { TRPCError } from "@trpc/server";
import type { Context } from "./context";
import { middleware, router } from "./trpc";
import { getAuth } from "@clerk/express";

export const isAuthenticated = middleware(async ({ ctx, next }) => {
  if (!ctx.req) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing request context",
    });
  }

  // Get auth info from Clerk
  const auth = getAuth(ctx.req);

  if (!auth.sessionId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or missing session",
    });
  }

  return next({
    ctx: {
      ...ctx,
      auth,
    },
  });
});

// Middleware to check if user is an admin
export const isAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.req) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing request context",
    });
  }

  // Get auth info from Clerk
  const auth = getAuth(ctx.req);

  if (!auth.sessionId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or missing session",
    });
  }

  // Fetch user from the database to check admin status
  const user = await ctx.prisma.user.findUnique({
    where: { id: auth.userId },
    include: { tier: true },
  });

  if (!user?.tier.isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }

  return next({
    ctx: {
      ...ctx,
      auth,
      user,
    },
  });
});
