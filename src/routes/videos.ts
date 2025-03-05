import { requireAuth } from "@clerk/express";
import express from "express";
import { logger } from "../utils/logger.js";
import { prisma } from "../lib/prisma.js";
import { isAuthenticated } from "../middleware/auth.js";

const router = express.Router();

// POST /api/videos/track-download
// Track a video download
router.post(
  "/track-download",
  isAuthenticated,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { jobId, templateKey, userId } = req.body;

      // Manual validation
      if (!jobId) {
        res.status(400).json({
          success: false,
          error: "Job ID is required",
        });
        return;
      }

      if (!templateKey) {
        res.status(400).json({
          success: false,
          error: "Template key is required",
        });
        return;
      }

      if (userId !== undefined && typeof userId !== "string") {
        res.status(400).json({
          success: false,
          error: "User ID must be a string",
        });
        return;
      }

      const userIdToUse = userId || req.user!.id;

      // Check if the user exists
      const user = await prisma.user.findUnique({
        where: { id: userIdToUse },
        include: { currentTier: true },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          error: "User not found",
        });
        return;
      }

      // Check if the job exists
      const job = await prisma.videoJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: "Video job not found",
        });
        return;
      }

      // For now, we'll just log the download attempt
      // The VideoDownload model is not yet available in the database
      // TODO: Once the migration is properly applied, implement download tracking and limits
      logger.info("Video download tracking requested", {
        userId: userIdToUse,
        jobId,
        templateKey,
        tier: user.currentTier?.name || "unknown",
        maxDownloads: user.currentTier?.maxReelDownloads,
      });

      // Return success response
      res.status(200).json({
        success: true,
        message: "Video download request processed",
        data: {
          userId: userIdToUse,
          jobId,
          templateKey,
          timestamp: new Date().toISOString(),
        },
      });
      return;
    } catch (error) {
      logger.error("Error tracking video download", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });

      res.status(500).json({
        success: false,
        error: "Failed to track video download",
      });
      return;
    }
  }
);

export { router as videosRouter };
