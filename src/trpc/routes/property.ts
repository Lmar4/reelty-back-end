import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../types";
import { prisma } from "../../lib/prisma";
import { v4 as uuidv4 } from "uuid";

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

  getById: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const listing = await prisma.listing.findUnique({
        where: { id: input.id },
        include: {
          photos: true,
          videoJobs: true,
        },
      });
      if (!listing) {
        throw new Error("Listing not found");
      }
      return listing;
    }),

  getUserListings: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Verify user is accessing their own listings
      if (input.userId !== ctx.user.uid) {
        throw new Error("Unauthorized: You can only access your own listings");
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
        photos: z.array(
          z.object({
            filePath: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is creating their own listing
      if (input.userId !== ctx.user.uid) {
        throw new Error(
          "Unauthorized: You can only create listings for yourself"
        );
      }

      const listing = await prisma.listing.create({
        data: {
          userId: input.userId,
          address: input.address,
          photos: {
            create: input.photos,
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
        throw new Error("Unauthorized: You can only update your own listings");
      }

      const { id, userId, ...data } = input;

      // Verify the listing belongs to the user
      const listing = await prisma.listing.findUnique({
        where: { id },
        select: { userId: true },
      });

      if (!listing) {
        throw new Error("Listing not found");
      }

      if (listing.userId !== userId) {
        throw new Error("Unauthorized: This listing doesn't belong to you");
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
        throw new Error("Unauthorized: You can only delete your own listings");
      }

      // Verify the listing belongs to the user
      const listing = await prisma.listing.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });

      if (!listing) {
        throw new Error("Listing not found");
      }

      if (listing.userId !== input.userId) {
        throw new Error("Unauthorized: This listing doesn't belong to you");
      }

      await prisma.listing.delete({
        where: { id: input.id },
      });
      return true;
    }),

  tempUpload: publicProcedure
    .input(
      z.object({
        files: z.array(
          z.object({
            filePath: z.string(),
            fileType: z.string(),
            fileSize: z.number(),
          })
        ),
        address: z.string().optional(),
        sessionId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const sessionId = input.sessionId || uuidv4();

      // Store temporary files info in Redis or temporary DB table
      await prisma.tempUpload.create({
        data: {
          sessionId,
          files: input.files,
          address: input.address,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
        },
      });

      return { sessionId };
    }),

  getTempUpload: publicProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const tempUpload = await prisma.tempUpload.findUnique({
        where: { sessionId: input.sessionId },
      });

      if (!tempUpload) {
        throw new Error("Temporary upload not found or expired");
      }

      return tempUpload;
    }),

  convertTempToListing: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        userId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify user is creating their own listing
      if (input.userId !== ctx.user.uid) {
        throw new Error(
          "Unauthorized: You can only create listings for yourself"
        );
      }

      // Get temp upload
      const tempUpload = await prisma.tempUpload.findUnique({
        where: { sessionId: input.sessionId },
      });

      if (!tempUpload) {
        throw new Error("Temporary upload not found or expired");
      }

      // Create actual listing
      const listing = await prisma.listing.create({
        data: {
          userId: input.userId,
          address: tempUpload.address || "",
          photos: {
            create: tempUpload.files.map((file) => ({
              filePath: file.filePath,
            })),
          },
        },
        include: {
          photos: true,
        },
      });

      // Delete temp upload
      await prisma.tempUpload.delete({
        where: { sessionId: input.sessionId },
      });

      return listing;
    }),
});
