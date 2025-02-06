import { inferAsyncReturnType, initTRPC, TRPCError } from "@trpc/server";
import * as trpcExpress from "@trpc/server/adapters/express";
import { prisma } from "../lib/prisma";
import { verifyFirebaseToken, type UserPayload } from "../lib/awsAdmin";

// Context type definition
export const createContext = async ({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions) => {
  // Get the token from the Authorization header
  const authHeader = req.headers.authorization;
  let user: UserPayload | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      user = await verifyFirebaseToken(token);
    } catch (error) {
      console.error("Error verifying token:", error);
    }
  }

  return {
    req,
    res,
    user,
  };
};

export type Context = inferAsyncReturnType<typeof createContext>;

// Initialize tRPC with async transformer
const initializeTRPC = async () => {
  const { default: superjson } = await import("superjson");
  return initTRPC.context<Context>().create({
    transformer: superjson,
  });
};

// Export an async function to get the initialized tRPC instance
export const getTRPC = async () => {
  const t = await initializeTRPC();

  // Create a middleware that checks for authentication
  const isAuthed = t.middleware(({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "You must be authenticated to access this resource",
      });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  });

  // Create a middleware that checks for admin privileges
  const isAdmin = t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) {
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

  return {
    router: t.router,
    publicProcedure: t.procedure,
    protectedProcedure: t.procedure.use(isAuthed),
    adminProcedure: t.procedure.use(isAdmin),
  };
};
