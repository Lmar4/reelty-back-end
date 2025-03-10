import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middleware/auth.js";
import { validateRequest } from "../middleware/validate.js";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline.js";
import { TemplateKey } from "../services/imageProcessing/templates/types.js";
import { createApiResponse } from "../types/api.js";
const router = express.Router();
const prisma = new PrismaClient();

// Initialize ProductionPipeline
const productionPipeline = new ProductionPipeline();

// Log warning if API key is missing
if (!process.env.RUNWAYML_API_KEY) {
  console.warn("[WARNING] RUNWAYML_API_KEY environment variable is not set!");
}

// Recover pending jobs on server start
async function recoverPendingJobs() {
  try {
    console.log("[RECOVERY] Looking for pending jobs...");

    // Try to use VideoJob first, but fall back to VideoGenerationJob if the table doesn't exist
    try {
      const pendingJobs = await prisma.videoJob.findMany({
        where: {
          status: VideoGenerationStatus.PENDING,
          createdAt: {
            // Only recover jobs from the last 24 hours
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        include: {
          listing: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        // Limit the number of jobs to recover
        take: 5,
      });

      if (pendingJobs.length > 0) {
        console.log(
          `[RECOVERY] Found ${pendingJobs.length} pending VideoJob jobs to recover`
        );

        // Process jobs one at a time to avoid overwhelming the system
        for (const job of pendingJobs) {
          // Check if there's already a processing job for this listing
          const existingProcessingJob = await prisma.videoJob.findFirst({
            where: {
              listingId: job.listingId,
              status: VideoGenerationStatus.PROCESSING,
            },
          });

          if (existingProcessingJob) {
            console.log(
              `[RECOVERY] Skipping job ${job.id} as listing ${job.listingId} already has a processing job`
            );
            continue;
          }

          console.log(`[RECOVERY] Restarting job: ${job.id}`);
          await productionPipeline
            .execute({
              jobId: job.id,
              inputFiles: Array.isArray(job.inputFiles)
                ? job.inputFiles.map(String)
                : [],
              template: (job.template as TemplateKey) || "googlezoomintro",
              coordinates: job.listing?.coordinates as
                | { lat: number; lng: number }
                | undefined,
            })
            .catch((error) => {
              console.error("[RECOVERY] Production pipeline error:", {
                jobId: job.id,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            });
        }
      } else {
        console.log("[RECOVERY] No pending VideoJob jobs found");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("does not exist in the current database")
      ) {
        console.log(
          "[RECOVERY] VideoJob table doesn't exist, falling back to VideoGenerationJob"
        );

        // Fall back to VideoGenerationJob
        const pendingJobs = await prisma.videoGenerationJob.findMany({
          where: {
            status: VideoGenerationStatus.PENDING,
            createdAt: {
              // Only recover jobs from the last 24 hours
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
            },
          },
          include: {
            user: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          // Limit the number of jobs to recover
          take: 5,
        });

        if (pendingJobs.length > 0) {
          console.log(
            `[RECOVERY] Found ${pendingJobs.length} pending VideoGenerationJob jobs to recover`
          );

          // Process jobs one at a time to avoid overwhelming the system
          for (const job of pendingJobs) {
            // Check if there's already a processing job for this user
            const existingProcessingJob =
              await prisma.videoGenerationJob.findFirst({
                where: {
                  userId: job.userId,
                  status: VideoGenerationStatus.PROCESSING,
                },
              });

            if (existingProcessingJob) {
              console.log(
                `[RECOVERY] Skipping job ${job.id} as user ${job.userId} already has a processing job`
              );
              continue;
            }

            console.log(`[RECOVERY] Restarting job: ${job.id}`);
            await productionPipeline
              .execute({
                jobId: job.id,
                inputFiles: Array.isArray(job.inputFiles)
                  ? job.inputFiles.map(String)
                  : [],
                template: (job.template as TemplateKey) || "googlezoomintro",
                coordinates: undefined, // VideoGenerationJob doesn't have listing with coordinates
              })
              .catch((error) => {
                console.error("[RECOVERY] Production pipeline error:", {
                  jobId: job.id,
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                });
              });
          }
        } else {
          console.log("[RECOVERY] No pending VideoGenerationJob jobs found");
        }
      } else {
        // Re-throw other errors
        throw error;
      }
    }
  } catch (error) {
    console.error("[RECOVERY] Error:", error);
  }
}

// Start job recovery on initialization
recoverPendingJobs();

// Validation schemas
const createJobSchema = z.object({
  body: z.object({
    listingId: z.string().uuid(),
    template: z.string().optional(),
    inputFiles: z
      .array(z.string().min(1))
      .transform((files) => files.filter(Boolean))
      .optional(),
  }),
});

const updateJobSchema = z.object({
  body: z.object({
    status: z.nativeEnum(VideoGenerationStatus).optional(),
    progress: z.number().min(0).max(100).optional(),
    template: z.string().optional(),
    inputFiles: z.array(z.string()).optional(),
    outputFile: z.string().optional(),
    error: z.string().nullable().optional(),
  }),
});

// Get all jobs for the authenticated user
const getAllJobs: RequestHandler = async (req, res) => {
  try {
    const { listingId } = req.query;

    const jobs = await prisma.videoJob.findMany({
      where: {
        userId: req.user!.id,
        ...(listingId && { listingId: listingId as string }),
      },
      include: {
        listing: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      data: jobs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Create new job
const createJob: RequestHandler = async (req, res) => {
  try {
    console.log("[CREATE_JOB] Starting job creation:", {
      listingId: req.body.listingId,
      template: req.body.template,
      inputFilesCount: req.body.inputFiles?.length,
    });

    const { listingId, template, inputFiles } = req.body;

    // Ensure inputFiles is an array and filter out any invalid values
    const validInputFiles = Array.isArray(inputFiles)
      ? inputFiles.filter(
          (file): file is string => typeof file === "string" && file.length > 0
        )
      : [];

    const listing = await prisma.listing.findUnique({
      where: {
        id: listingId,
        userId: req.user!.id,
      },
    });

    if (!listing) {
      console.log("[CREATE_JOB] Listing not found or access denied:", {
        listingId,
      });
      res.status(404).json({
        success: false,
        error: "Listing not found or access denied",
      });
      return;
    }

    // Get default template if none specified
    let templateId = template;
    if (!templateId) {
      const defaultTemplate = await prisma.template.findFirst({
        where: {
          name: "googlezoomintro",
        },
      });
      if (!defaultTemplate) {
        res.status(500).json({
          success: false,
          error: "Default template not found",
        });
        return;
      }
      templateId = defaultTemplate.name;
    }

    const job = await prisma.videoJob.create({
      data: {
        userId: req.user!.id,
        listingId,
        status: VideoGenerationStatus.PENDING,
        progress: 0,
        template: templateId || "googlezoomintro",
        inputFiles: validInputFiles,
      },
      include: {
        listing: true,
      },
    });

    console.log("[CREATE_JOB] Job created successfully:", {
      jobId: job.id,
      status: job.status,
      template: job.template,
    });

    // Start the production pipeline asynchronously
    console.log("[CREATE_JOB] Starting production pipeline for job:", job.id);
    productionPipeline
      .execute({
        jobId: job.id,
        inputFiles: Array.isArray(job.inputFiles)
          ? job.inputFiles.map(String)
          : [],
        template: (job.template as TemplateKey) || "googlezoomintro",
        coordinates: (
          await prisma.listing.findUnique({ where: { id: job.listingId } })
        )?.coordinates as { lat: number; lng: number } | undefined,
      })
      .catch((error) => {
        console.error("[CREATE_JOB] Production pipeline error:", {
          jobId: job.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    res.status(201).json(createApiResponse(true, job));
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to create job"
        )
      );
  }
};

// Get specific job
const getJob: RequestHandler = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await prisma.videoJob.findUnique({
      where: {
        id: jobId,
        userId: req.user!.id,
      },
      include: {
        listing: true,
      },
    });

    if (!job) {
      res.status(404).json({
        success: false,
        error: "Job not found",
      });
      return;
    }

    res.json({
      success: true,
      data: job,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Update specific job
const updateJob: RequestHandler = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await prisma.videoJob.update({
      where: {
        id: jobId,
        userId: req.user!.id,
      },
      data: req.body,
      include: {
        listing: true,
      },
    });

    res.json({
      success: true,
      data: job,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Record to update not found")
    ) {
      res.status(404).json({
        success: false,
        error: "Job not found",
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Delete specific job
const deleteJob: RequestHandler = async (req, res) => {
  try {
    const { jobId } = req.params;
    await prisma.videoJob.delete({
      where: {
        id: jobId,
        userId: req.user!.id,
      },
    });

    res.json(createApiResponse(true, null, "Job deleted successfully"));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Record to delete does not exist")
    ) {
      res
        .status(404)
        .json(createApiResponse(false, undefined, undefined, "Job not found"));
      return;
    }
    res
      .status(500)
      .json(
        createApiResponse(false, undefined, undefined, "Failed to delete job")
      );
  }
};

// Regenerate specific job
const regenerateJob: RequestHandler = async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const userId = req.user!.id;

    const recentRegenerations = await prisma.videoJob.count({
      where: {
        userId,
        createdAt: {
          gte: new Date(Date.now() - 1000 * 60 * 60),
        },
        status: VideoGenerationStatus.PENDING,
      },
    });

    if (recentRegenerations >= 5) {
      res.status(429).json({
        error: "Too many regeneration attempts. Please try again later.",
      });
      return;
    }

    const existingJob = await prisma.videoJob.findUnique({
      where: { id: jobId },
      include: { listing: true },
    });

    if (!existingJob) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (existingJob.userId !== userId) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    const newJob = await prisma.videoJob.create({
      data: {
        userId,
        listingId: existingJob.listingId,
        status: VideoGenerationStatus.PENDING,
        template: existingJob.template,
        inputFiles: existingJob.inputFiles as any,
        priority: existingJob.priority,
      },
    });

    productionPipeline
      .execute({
        jobId: newJob.id,
        inputFiles: Array.isArray(newJob.inputFiles)
          ? newJob.inputFiles.map(String)
          : [],
        template: (newJob.template as TemplateKey) || "googlezoomintro",
        coordinates: existingJob.listing?.coordinates as
          | { lat: number; lng: number }
          | undefined,
      })
      .catch((error) => {
        console.error("[REGENERATE] Production pipeline error:", {
          jobId: newJob.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    res.json(newJob);
  } catch (error) {
    console.error("[REGENERATE_JOB]", error);
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to regenerate job",
    });
  }
};

// Route handlers
router.get("/", isAuthenticated, getAllJobs);
router.post("/", isAuthenticated, validateRequest(createJobSchema), createJob);
router.get("/:jobId", isAuthenticated, getJob);
router.patch(
  "/:jobId",
  isAuthenticated,
  validateRequest(updateJobSchema),
  updateJob
);
router.delete("/:jobId", isAuthenticated, deleteJob);
router.post("/:jobId/regenerate", isAuthenticated, regenerateJob);

export default router;
