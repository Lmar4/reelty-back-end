import { TRPCError } from "@trpc/server";
import { prisma } from "../../lib/prisma";
import type { Context } from "../types";
import { initTRPC } from "@trpc/server";

// Initialize tRPC with the context type
const t = initTRPC.context<Context>().create();

export const isAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user?.uid) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  const tier = await prisma.subscriptionTier.findFirst({
    where: {
      id: {
        equals: (
          await prisma.user.findUnique({
            where: { id: ctx.user.uid },
            select: { subscriptionTier: true },
          })
        )?.subscriptionTier,
      },
      isAdmin: true,
    },
  });

  if (!tier) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You must be an admin to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: {
        ...ctx.user,
        isAdmin: true,
      },
    },
  });
});
