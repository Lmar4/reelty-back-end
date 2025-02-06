import { z } from "zod";
import { getRouteUtils } from "./routeHelper";
import { prisma } from "../../lib/prisma";

// Initialize the router with async tRPC
const initializeJobsRouter = async () => {
  const { router, protectedProcedure } = await getRouteUtils();

  return router({
    submit: protectedProcedure
      .input(
        z.object({
          userId: z.string().uuid(),
          listingId: z.string().uuid(),
          inputFiles: z.array(z.string()),
          template: z.string().default("crescendo"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Verify the user is modifying their own data
        if (input.userId !== ctx.user.uid) {
          throw new Error(
            "Unauthorized: You can only submit jobs for your own account"
          );
        }

        const job = await prisma.videoJob.create({
          data: {
            userId: input.userId,
            listingId: input.listingId,
            inputFiles: input.inputFiles,
            template: input.template,
            status: "pending",
          },
        });
        return job;
      }),

    getStatus: protectedProcedure
      .input(z.object({ jobId: z.string().uuid() }))
      .query(async ({ input }) => {
        const job = await prisma.videoJob.findUnique({
          where: { id: input.jobId },
          include: {
            listing: {
              include: {
                photos: true,
              },
            },
          },
        });
        if (!job) {
          throw new Error("Job not found");
        }
        return job;
      }),

    getListingJobs: protectedProcedure
      .input(z.object({ listingId: z.string().uuid() }))
      .query(async ({ input }) => {
        const jobs = await prisma.videoJob.findMany({
          where: { listingId: input.listingId },
          orderBy: { createdAt: "desc" },
          include: {
            listing: {
              include: {
                photos: true,
              },
            },
          },
        });
        return jobs;
      }),

    getVideoDownloadUrl: protectedProcedure
      .input(z.object({ jobId: z.string().uuid() }))
      .query(async ({ input }) => {
        const job = await prisma.videoJob.findUnique({
          where: { id: input.jobId },
        });
        if (!job) {
          throw new Error("Job not found");
        }
        if (job.status !== "completed") {
          throw new Error("Video is not ready yet");
        }
        if (!job.outputFile) {
          throw new Error("Video URL not available");
        }
        return job.outputFile;
      }),

    createVideo: protectedProcedure
      .input(
        z.object({
          listingId: z.string().uuid(),
          userId: z.string().uuid(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Verify the user is modifying their own data
        if (input.userId !== ctx.user.uid) {
          throw new Error(
            "Unauthorized: You can only create videos for your own account"
          );
        }

        const job = await prisma.videoJob.create({
          data: {
            userId: input.userId,
            listingId: input.listingId,
            status: "pending",
            template: "crescendo",
            inputFiles: [],
          },
        });
        return job;
      }),

    getUserJobs: protectedProcedure
      .input(
        z.object({
          userId: z.string().uuid(),
          limit: z.number().min(1).max(100).default(10),
          cursor: z.string().uuid().nullish(),
        })
      )
      .query(async ({ input, ctx }) => {
        // Verify the user is accessing their own data
        if (input.userId !== ctx.user.uid) {
          throw new Error("Unauthorized: You can only access your own jobs");
        }

        const jobs = await prisma.videoJob.findMany({
          where: { userId: input.userId },
          take: input.limit + 1,
          cursor: input.cursor ? { id: input.cursor } : undefined,
          orderBy: { createdAt: "desc" },
          include: {
            listing: {
              include: {
                photos: true,
              },
            },
          },
        });

        let nextCursor: typeof input.cursor = undefined;
        if (jobs.length > input.limit) {
          const nextItem = jobs.pop();
          nextCursor = nextItem?.id;
        }

        return {
          items: jobs,
          nextCursor,
        };
      }),

    regenerateVideos: protectedProcedure
      .input(
        z.object({
          listingId: z.string().uuid(),
          photoIds: z.array(z.string().uuid()),
          template: z.string(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Verify user owns the listing
        const listing = await prisma.listing.findUnique({
          where: { id: input.listingId },
          include: {
            photos: true,
            videoJobs: {
              where: {
                template: input.template,
              },
            },
          },
        });

        if (!listing) {
          throw new Error("Listing not found");
        }

        if (listing.userId !== ctx.user.uid) {
          throw new Error(
            "Unauthorized: You can only regenerate your own listings"
          );
        }

        // Verify all photoIds belong to this listing
        const validPhotoIds = listing.photos.map((p) => p.id);
        const invalidPhotoIds = input.photoIds.filter(
          (id) => !validPhotoIds.includes(id)
        );
        if (invalidPhotoIds.length > 0) {
          throw new Error("Some selected photos do not belong to this listing");
        }

        // Delete existing video jobs for this template
        await prisma.videoJob.deleteMany({
          where: {
            listingId: input.listingId,
            template: input.template,
          },
        });

        // Create new video job for selected photos
        const selectedPhotos = listing.photos.filter((p) =>
          input.photoIds.includes(p.id)
        );
        const job = await prisma.videoJob.create({
          data: {
            userId: ctx.user.uid,
            listingId: input.listingId,
            template: input.template,
            status: "pending",
            inputFiles: selectedPhotos.map((p) => p.filePath),
          },
        });

        return job;
      }),
  });
};

// Export an async function to get the initialized router
export const getJobsRouter = async () => {
  return await initializeJobsRouter();
};
