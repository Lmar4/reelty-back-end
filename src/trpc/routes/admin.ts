import { z } from "zod";
import { getRouteUtils } from "./routeHelper";
import { prisma } from "../../lib/prisma";
import { TRPCError } from "@trpc/server";

// Define AssetType enum since it's not exported from @prisma/client
enum AssetType {
  MUSIC = "MUSIC",
  WATERMARK = "WATERMARK",
  LOTTIE = "LOTTIE",
}

// Input validation schemas
const templateInput = z.object({
  name: z.string(),
  description: z.string(),
  sequence: z.array(z.string()),
  durations: z.array(z.number()),
  musicPath: z.string().optional(),
  musicVolume: z.number().min(0).max(1).default(1),
  subscriptionTier: z.string(),
  isActive: z.boolean().default(true),
});

const assetInput = z.object({
  name: z.string(),
  description: z.string().optional(),
  filePath: z.string(),
  type: z.enum(["MUSIC", "WATERMARK", "LOTTIE"]),
  subscriptionTier: z.string(),
  isActive: z.boolean().default(true),
});

// Initialize the router with async tRPC
const initializeAdminPanelRouter = async () => {
  const { router, adminProcedure } = await getRouteUtils();

  return router({
    // User Statistics
    getUserStats: adminProcedure.query(async () => {
      const [totalUsers, activeUsersToday, activeUsersThisMonth, usersByTier] =
        await Promise.all([
          // Total users
          prisma.user.count(),

          // Active users today
          prisma.user.count({
            where: {
              lastLoginAt: {
                gte: new Date(new Date().setHours(0, 0, 0, 0)),
              },
            },
          }),

          // Active users this month
          prisma.user.count({
            where: {
              lastLoginAt: {
                gte: new Date(new Date().setDate(1)),
              },
            },
          }),

          // Users by tier
          prisma.user.groupBy({
            by: ["subscriptionTier"],
            _count: true,
          }),
        ]);

      return {
        totalUsers,
        activeUsersToday,
        activeUsersThisMonth,
        usersByTier,
      };
    }),

    // Credit Usage Statistics
    getCreditStats: adminProcedure.query(async () => {
      const creditStats = await prisma.listingCredit.aggregate({
        _sum: {
          creditsRemaining: true,
        },
        _avg: {
          creditsRemaining: true,
        },
      });

      return creditStats;
    }),

    // System Performance
    getSystemStats: adminProcedure.query(async () => {
      const [totalListings, totalSearches, errorCount] = await Promise.all([
        prisma.listing.count(),
        prisma.searchHistory.count(),
        prisma.errorLog.count({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
            },
          },
        }),
      ]);

      return {
        totalListings,
        totalSearches,
        errorCount,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      };
    }),

    // User Management
    updateUserTier: adminProcedure
      .input(
        z.object({
          userId: z.string(),
          tier: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const user = await prisma.user.update({
            where: { id: input.userId },
            data: { subscriptionTier: input.tier },
          });
          return user;
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to update user tier",
          });
        }
      }),

    // Feature Usage Analytics
    getFeatureUsage: adminProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input }) => {
        const [listingUploads, searches] = await Promise.all([
          // Listing upload statistics
          prisma.listing.groupBy({
            by: ["userId"],
            where: {
              createdAt: {
                gte: input.startDate,
                lte: input.endDate,
              },
            },
            _count: true,
          }),

          // Search statistics
          prisma.searchHistory.groupBy({
            by: ["userId"],
            where: {
              createdAt: {
                gte: input.startDate,
                lte: input.endDate,
              },
            },
            _count: true,
          }),
        ]);

        return {
          listingUploads,
          searches,
        };
      }),

    // Template Management
    getTemplates: adminProcedure.query(async () => {
      return prisma.template.findMany({
        where: { isActive: true },
        orderBy: { createdAt: "desc" },
      });
    }),

    createTemplate: adminProcedure
      .input(templateInput)
      .mutation(async ({ input }) => {
        return prisma.template.create({
          data: {
            name: input.name,
            description: input.description,
            sequence: input.sequence,
            durations: input.durations,
            musicPath: input.musicPath,
            musicVolume: input.musicVolume,
            subscriptionTier: input.subscriptionTier,
            isActive: input.isActive,
          },
        });
      }),

    updateTemplate: adminProcedure
      .input(z.object({ id: z.string() }).merge(templateInput.partial()))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return prisma.template.update({
          where: { id },
          data: {
            ...(data.name && { name: data.name }),
            ...(data.description && { description: data.description }),
            ...(data.sequence && { sequence: data.sequence }),
            ...(data.durations && { durations: data.durations }),
            ...(data.musicPath && { musicPath: data.musicPath }),
            ...(data.musicVolume && { musicVolume: data.musicVolume }),
            ...(data.subscriptionTier && {
              subscriptionTier: data.subscriptionTier,
            }),
            ...(data.isActive !== undefined && { isActive: data.isActive }),
          },
        });
      }),

    deleteTemplate: adminProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        return prisma.template.update({
          where: { id: input.id },
          data: { isActive: false },
        });
      }),

    // Asset Management
    getAssets: adminProcedure
      .input(
        z.object({
          type: z.enum(["MUSIC", "WATERMARK", "LOTTIE"]).optional(),
          includeInactive: z.boolean().default(false),
        })
      )
      .query(async ({ input }) => {
        return prisma.asset.findMany({
          where: {
            ...(input.type && { type: input.type }),
            ...(!input.includeInactive && { isActive: true }),
          },
          orderBy: { createdAt: "desc" },
        });
      }),

    createAsset: adminProcedure
      .input(assetInput)
      .mutation(async ({ input }) => {
        return prisma.asset.create({
          data: {
            name: input.name,
            description: input.description,
            filePath: input.filePath,
            type: input.type,
            subscriptionTier: input.subscriptionTier,
            isActive: input.isActive,
          },
        });
      }),

    updateAsset: adminProcedure
      .input(z.object({ id: z.string() }).merge(assetInput.partial()))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return prisma.asset.update({
          where: { id },
          data: {
            ...(data.name && { name: data.name }),
            ...(data.description && { description: data.description }),
            ...(data.filePath && { filePath: data.filePath }),
            ...(data.type && { type: data.type }),
            ...(data.subscriptionTier && {
              subscriptionTier: data.subscriptionTier,
            }),
            ...(data.isActive !== undefined && { isActive: data.isActive }),
          },
        });
      }),

    deleteAsset: adminProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        return prisma.asset.update({
          where: { id: input.id },
          data: { isActive: false },
        });
      }),

    // Credit Management
    getCreditLogs: adminProcedure.query(async () => {
      return prisma.creditLog.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: true,
          admin: true,
        },
      });
    }),

    upsertUserCredits: adminProcedure
      .input(
        z.object({
          userId: z.string(),
          credits: z.number().int().positive(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { userId, credits } = input;

        return prisma.creditLog.create({
          data: {
            userId: userId,
            amount: credits,
            reason: "Admin credit adjustment",
            adminId: ctx.user.uid,
          },
        });
      }),

    // Tier Change Management
    getTierChanges: adminProcedure
      .input(
        z
          .object({
            userId: z.string().uuid().optional(),
            startDate: z.date().optional(),
            endDate: z.date().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return prisma.tierChange.findMany({
          where: {
            ...(input?.userId ? { userId: input.userId } : {}),
            ...(input?.startDate || input?.endDate
              ? {
                  createdAt: {
                    ...(input.startDate ? { gte: input.startDate } : {}),
                    ...(input.endDate ? { lte: input.endDate } : {}),
                  },
                }
              : {}),
          },
          include: {
            user: true,
            admin: true,
          },
          orderBy: { createdAt: "desc" },
        });
      }),
  });
};

// Export an async function to get the initialized router
export const getAdminPanelRouter = async () => {
  return await initializeAdminPanelRouter();
};
