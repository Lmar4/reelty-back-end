import { z } from "zod";
import { getRouteUtils } from "./routeHelper";
import { prisma } from "../../lib/prisma";

// Initialize the router with async tRPC
const initializeUserRouter = async () => {
  const { router, publicProcedure, protectedProcedure } = await getRouteUtils();

  return router({
    getUser: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        // Verify user is accessing their own data
        if (input.id !== ctx.user.uid) {
          throw new Error(
            "Unauthorized: You can only access your own user data"
          );
        }

        const user = await prisma.user.findUnique({
          where: { id: input.id },
          include: {
            listingCredits: true,
            listings: {
              include: {
                photos: true,
                videoJobs: true,
              },
            },
          },
        });
        if (!user) {
          throw new Error("User not found");
        }
        return user;
      }),

    updateUser: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          name: z.string().optional(),
          email: z.string().email().optional(),
          fcmToken: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Verify user is updating their own data
        if (input.id !== ctx.user.uid) {
          throw new Error(
            "Unauthorized: You can only update your own user data"
          );
        }

        const { id, ...data } = input;
        const user = await prisma.user.update({
          where: { id },
          data,
        });
        return user;
      }),

    createUser: publicProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          email: z.string().email(),
          name: z.string(),
          subscriptionTier: z.string().default("free"),
          fcmToken: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const user = await prisma.user.create({
          data: {
            ...input,
          },
        });
        return user;
      }),
  });
};

// Export an async function to get the initialized router
export const getUserRouter = async () => {
  return await initializeUserRouter();
};
