import { Router } from "express";
import { VideoQueueService } from "../services/queue/videoQueue";
import { isAuthenticated } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { z } from "zod";
import { logger } from "../utils/logger";

const router = Router();
const queueService = VideoQueueService.getInstance();

// Validation schemas
const enqueueJobSchema = z.object({
  body: z.object({
    listingId: z.string().uuid(),
    inputFiles: z.array(z.string()),
    template: z.string(),
    priority: z.number().optional(),
  }),
});

// Enqueue a new video generation job
router.post(
  "/enqueue",
  isAuthenticated,
  validateRequest(enqueueJobSchema),
  async (req, res) => {
    try {
      const job = await queueService.enqueueJob({
        userId: req.user!.id,
        ...req.body,
      });

      logger.info("Video generation job enqueued", {
        jobId: job.id,
        userId: req.user!.id,
        listingId: req.body.listingId,
      });

      res.status(201).json({
        success: true,
        data: job,
      });
    } catch (error) {
      logger.error("Failed to enqueue video generation job", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        userId: req.user!.id,
        listingId: req.body.listingId,
      });

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to enqueue job",
      });
    }
  }
);

// Get queue status for user
router.get("/status", isAuthenticated, async (req, res) => {
  try {
    const jobs = await queueService.getQueueStatus(req.user!.id);

    res.json({
      success: true,
      data: jobs,
    });
  } catch (error) {
    logger.error("Failed to get queue status", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      userId: req.user!.id,
    });

    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to get queue status",
    });
  }
});

export default router;
