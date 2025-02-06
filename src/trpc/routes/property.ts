import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { protectedProcedure, publicProcedure, router } from "../types";

// Common file schema
const fileSchema = z.object({
  filePath: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  contentType: z.string().optional(),
});

type FileData = z.infer<typeof fileSchema>;

export const propertyRouter = router({
  getProperties: publicProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(10),
        cursor: z.string().nullish(),
      })
    )
    .query(async ({ input }) => {
      const listings = await prisma.listing.findMany({
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          photos: true,
        },
      });

      let nextCursor: typeof input.cursor = undefined;
      if (listings.length > input.limit) {
        const nextItem = listings.pop();
        nextCursor = nextItem?.id;
      }

      return {
        items: listings,
        nextCursor,
      };
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const listing = await prisma.listing.findUnique({
        where: { id: input.id },
        include: {
          photos: true,
          videoJobs: true,
        },
      });
      if (!listing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Listing not found",
        });
      }
      if (listing.userId !== ctx.user.uid) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      return listing;
    }),

  getUserListings: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Verify user is accessing their own listings
      if (input.userId !== ctx.user.uid) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const listings = await prisma.listing.findMany({
        where: { userId: input.userId },
        orderBy: { createdAt: "desc" },
        include: {
          photos: true,
          videoJobs: true,
        },
      });
      return listings;
    }),

  create: protectedProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        address: z.string(),
        photos: z.array(fileSchema),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is creating their own listing
      if (input.userId !== ctx.user.uid) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const listing = await prisma.listing.create({
        data: {
          userId: ctx.user.uid,
          address: input.address,
          status: "draft",
          photos: {
            create: input.photos.map((photo) => ({
              userId: ctx.user.uid,
              filePath: photo.filePath,
              user: {
                connect: { id: ctx.user.uid },
              },
            })),
          },
        },
        include: {
          photos: true,
        },
      });
      return listing;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        userId: z.string().uuid(),
        address: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is updating their own listing
      if (input.userId !== ctx.user.uid) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const { id, userId, ...data } = input;

      // Verify the listing belongs to the user
      const listing = await prisma.listing.findUnique({
        where: { id },
        select: { userId: true },
      });

      if (!listing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Listing not found",
        });
      }

      if (listing.userId !== userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const updatedListing = await prisma.listing.update({
        where: { id },
        data,
        include: {
          photos: true,
        },
      });
      return updatedListing;
    }),

  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        userId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is deleting their own listing
      if (input.userId !== ctx.user.uid) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Verify the listing belongs to the user
      const listing = await prisma.listing.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });

      if (!listing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Listing not found",
        });
      }

      if (listing.userId !== input.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      await prisma.listing.delete({
        where: { id: input.id },
      });
      return true;
    }),

  tempUpload: protectedProcedure
    .input(
      z.object({
        files: z.array(fileSchema),
        address: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Store temporary files info
      const tempUpload = await prisma.tempUpload.create({
        data: {
          userId: ctx.user.uid,
          files: input.files,
          address: input.address,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
        },
      });

      return tempUpload;
    }),

  getTempUpload: protectedProcedure.query(async ({ ctx }) => {
    const tempUpload = await prisma.tempUpload.findFirst({
      where: {
        userId: ctx.user.uid,
        expiresAt: { gt: new Date() },
      },
    });

    if (!tempUpload) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Temporary upload not found or expired",
      });
    }

    return tempUpload;
  }),

  convertTempToListing: protectedProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is creating their own listing
      if (input.userId !== ctx.user.uid) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const tempUpload = await prisma.tempUpload.findFirst({
        where: {
          userId: ctx.user.uid,
          expiresAt: { gt: new Date() },
        },
      });

      if (!tempUpload) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temporary upload not found or expired",
        });
      }

      // Create the listing
      const listing = await prisma.listing.create({
        data: {
          userId: ctx.user.uid,
          address: tempUpload.address || "",
          status: "draft",
          photos: {
            create: (tempUpload.files as FileData[]).map((file) => ({
              userId: ctx.user.uid,
              filePath: file.filePath,
              user: {
                connect: { id: ctx.user.uid },
              },
            })),
          },
        },
        include: {
          photos: true,
        },
      });

      // Clean up temp upload
      await prisma.tempUpload.delete({
        where: { id: tempUpload.id },
      });

      return listing;
    }),
});
