import { inferAsyncReturnType, initTRPC, TRPCError } from "@trpc/server";
import * as trpcExpress from "@trpc/server/adapters/express";
import superjson from "superjson";
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

// Initialize tRPC
const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

// Export reusable router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;

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
      // Adds user information to the context
      user: ctx.user,
    },
  });
});

// Protected procedure that requires authentication
export const protectedProcedure = t.procedure.use(isAuthed);
