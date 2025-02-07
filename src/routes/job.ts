import express, { RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { getAuth } from "@clerk/express";

const router = express.Router();
const prisma = new PrismaClient();

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
    status: z.string().optional(),
    template: z.string().optional(),
    inputFiles: z.array(z.string()).optional(),
    outputFile: z.string().optional(),
    error: z.string().optional(),
  }),
});

// Get all jobs for the authenticated user
const getAllJobs: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const jobs = await prisma.videoJob.findMany({
      where: {
        userId: auth.userId,
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
    console.error("Get jobs error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Create new job
const createJob: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { listingId, template, inputFiles } = req.body;

    // Verify listing belongs to user
    const listing = await prisma.listing.findUnique({
      where: {
        id: listingId,
        userId: auth.userId,
      },
    });

    if (!listing) {
      res.status(404).json({
        success: false,
        error: "Listing not found or access denied",
      });
      return;
    }

    const job = await prisma.videoJob.create({
      data: {
        userId: auth.userId,
        listingId,
        status: "PENDING",
        template,
        inputFiles: inputFiles || [],
      },
      include: {
        listing: true,
      },
    });

    res.status(201).json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error("Create job error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get specific job
const getJob: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { jobId } = req.params;
    const job = await prisma.videoJob.findUnique({
      where: {
        id: jobId,
        userId: auth.userId,
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
    console.error("Get job error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Update specific job
const updateJob: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { jobId } = req.params;
    const job = await prisma.videoJob.update({
      where: {
        id: jobId,
        userId: auth.userId,
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
    console.error("Update job error:", error);
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
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { jobId } = req.params;
    await prisma.videoJob.delete({
      where: {
        id: jobId,
        userId: auth.userId,
      },
    });

    res.json({
      success: true,
      message: "Job deleted successfully",
    });
  } catch (error) {
    console.error("Delete job error:", error);
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
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { jobId } = req.params;

    // Find the existing job
    const existingJob = await prisma.videoJob.findUnique({
      where: {
        id: jobId,
        userId: auth.userId,
      },
    });

    if (!existingJob) {
      res.status(404).json({
        success: false,
        error: "Job not found",
      });
      return;
    }

    // Create a new job with the same parameters
    const newJob = await prisma.videoJob.create({
      data: {
        userId: auth.userId,
        listingId: existingJob.listingId,
        status: "PENDING",
        template: existingJob.template,
        inputFiles: existingJob.inputFiles || [],
      },
      include: {
        listing: true,
      },
    });

    res.status(201).json({
      success: true,
      data: newJob,
    });
  } catch (error) {
    console.error("Regenerate job error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.get("/", getAllJobs);
router.post("/", validateRequest(createJobSchema), createJob);
router.get("/:jobId", getJob);
router.patch("/:jobId", validateRequest(updateJobSchema), updateJob);
router.delete("/:jobId", deleteJob);
router.post("/:jobId/regenerate", regenerateJob);

export default router;
