import { TRPCError } from "@trpc/server";
import { t } from "../types";
import { prisma } from "../../lib/prisma";
import type { Context } from "../types";

export const isAdmin = t.middleware(
  async ({ ctx, next }: { ctx: Context; next: any }) => {
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
  }
);
