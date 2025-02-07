import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context";
import { validateRequest } from "../middleware/auth";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

// Base middleware for authenticated routes
export const isAuthed = middleware(async ({ ctx, next }) => {
  if (!ctx.req) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing request context",
    });
  }

  try {
    const auth = await validateRequest(ctx.req);
    return next({
      ctx: {
        ...ctx,
        auth,
      },
    });
  } catch (error) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid authentication",
      cause: error,
    });
  }
});

// Protected procedure - requires authentication
export const protectedProcedure = t.procedure.use(isAuthed);
