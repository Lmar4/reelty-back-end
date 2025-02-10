import { PrismaClient } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { ProductionPipeline } from "../services/imageProcessing/productionPipeline";

const router = express.Router();
const prisma = new PrismaClient();

// Initialize ProductionPipeline
const productionPipeline = new ProductionPipeline();

// Cleanup jobs with incorrect template names
async function cleanupIncorrectJobs() {
  try {
    console.log("[CLEANUP] Looking for jobs with incorrect template names...");

    // Find all jobs with incorrect template names
    const jobsToDelete = await prisma.videoJob.findMany({
      where: {
        OR: [{ template: "default_template" }, { template: "googlezoomintro" }],
      },
    });

    if (jobsToDelete.length > 0) {
      console.log(`[CLEANUP] Found ${jobsToDelete.length} jobs to delete`);

      // Delete all jobs with incorrect template names
      await prisma.videoJob.deleteMany({
        where: {
          OR: [
            { template: "default_template" },
            { template: "googlezoomintro" },
          ],
        },
      });

      console.log(
        "[CLEANUP] Successfully deleted jobs with incorrect templates"
      );
    } else {
      console.log("[CLEANUP] No jobs found with incorrect template names");
    }
  } catch (error) {
    console.error("[CLEANUP] Error:", error);
  }
}

// Run cleanup before recovering pending jobs
cleanupIncorrectJobs().then(() => {
  // Start job recovery after cleanup
  recoverPendingJobs();
});

// Log warning if API key is missing
if (!process.env.RUNWAYML_API_KEY) {
  console.warn("[WARNING] RUNWAYML_API_KEY environment variable is not set!");
}

// Recover pending jobs on server start
async function recoverPendingJobs() {
  try {
    console.log("[RECOVERY] Looking for pending jobs...");
    const pendingJobs = await prisma.videoJob.findMany({
      where: {
        status: "pending",
      },
      include: {
        listing: true,
      },
    });

    if (pendingJobs.length > 0) {
      console.log(
        `[RECOVERY] Found ${pendingJobs.length} pending jobs to recover`
      );
      for (const job of pendingJobs) {
        console.log(`[RECOVERY] Restarting job: ${job.id}`);
        productionPipeline
          .execute({
            jobId: job.id,
            inputFiles: Array.isArray(job.inputFiles)
              ? job.inputFiles.map(String)
              : [],
            template: job.template || "Google Zoom Intro",
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
      console.log("[RECOVERY] No pending jobs found");
    }
  } catch (error) {
    console.error("[RECOVERY] Error recovering pending jobs:", error);
  }
}

// Validation schemas
const createJobSchema = z.object({
  body: z.object({
    listingId: z.string().uuid(),
    template: z.string().optional(),
    inputFiles: z.array(z.string()).optional(),
  }),
});

const updateJobSchema = z.object({
  body: z.object({
    status: z.enum(["pending", "processing", "completed", "error"]).optional(),
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
          name: "Google Zoom Intro",
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
        status: "pending",
        progress: 0,
        template: templateId || "Google Zoom Intro",
        inputFiles: inputFiles || [],
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
        template: job.template || "Google Zoom Intro",
        coordinates: job.listing?.coordinates as
          | { lat: number; lng: number }
          | undefined,
      })
      .catch((error) => {
        console.error("[CREATE_JOB] Production pipeline error:", {
          jobId: job.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    res.status(201).json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error("[CREATE_JOB] Error creating job:", {
      error: error instanceof Error ? error.message : "Unknown error",
      body: req.body,
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
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

    res.json({
      success: true,
      message: "Job deleted successfully",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Record to delete does not exist")
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

// Regenerate specific job
const regenerateJob: RequestHandler = async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log("[REGENERATE_JOB] Starting regeneration:", {
      jobId,
      userId: req.user?.id,
    });

    // Find the existing job
    const existingJob = await prisma.videoJob.findUnique({
      where: {
        id: jobId,
        userId: req.user!.id,
      },
      include: {
        listing: true,
      },
    });

    console.log("[REGENERATE_JOB] Found existing job:", {
      jobId,
      listingId: existingJob?.listingId,
      template: existingJob?.template,
      inputFilesCount: Array.isArray(existingJob?.inputFiles)
        ? existingJob.inputFiles.length
        : 0,
    });

    if (!existingJob) {
      res.status(404).json({
        success: false,
        error: "Job not found",
      });
      return;
    }

    // Create a new job with the same parameters
    const template = await prisma.template.findFirst({
      where: {
        name: "Google Zoom Intro",
      },
    });

    if (!template) {
      throw new Error("Template 'Google Zoom Intro' not found in database");
    }

    const newJob = await prisma.videoJob.create({
      data: {
        userId: req.user!.id,
        listingId: existingJob.listingId,
        status: "pending",
        template: template.name || "Google Zoom Intro",
        inputFiles: existingJob.inputFiles || [],
      },
      include: {
        listing: true,
      },
    });

    console.log("[REGENERATE_JOB] Created new job:", {
      newJobId: newJob.id,
      template: newJob.template,
      listingId: newJob.listingId,
      inputFilesCount: Array.isArray(newJob.inputFiles)
        ? newJob.inputFiles.length
        : 0,
    });

    // Start the production pipeline asynchronously
    console.log(
      "[REGENERATE_JOB] Starting production pipeline for job:",
      newJob.id
    );
    productionPipeline
      .execute({
        jobId: newJob.id,
        inputFiles: Array.isArray(newJob.inputFiles)
          ? newJob.inputFiles.map(String)
          : [],
        template: newJob.template || "Google Zoom Intro",
        coordinates: newJob.listing?.coordinates as
          | { lat: number; lng: number }
          | undefined,
      })
      .catch((error) => {
        console.error("[REGENERATE_JOB] Production pipeline error:", {
          jobId: newJob.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    res.status(201).json({
      success: true,
      data: newJob,
    });
  } catch (error) {
    console.error("[REGENERATE_JOB] Error:", {
      error: error instanceof Error ? error.message : "Unknown error",
      jobId: req.params.jobId,
      userId: req.user?.id,
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
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
