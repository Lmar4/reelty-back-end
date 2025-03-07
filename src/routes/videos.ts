import { requireAuth } from "@clerk/express";
import express from "express";
import { logger } from "../utils/logger.js";
import { prisma } from "../lib/prisma.js";
import { isAuthenticated } from "../middleware/auth.js";
import { Prisma } from "@prisma/client";

const router = express.Router();

// POST /api/videos/track-download
// Track a video download and enforce download limits
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

      // Check if the user exists and get their subscription tier
      const user = await prisma.user.findUnique({
        where: { id: userIdToUse },
        include: {
          currentTier: true,
          videoDownloads: {
            where: {
              jobId,
            },
          },
        },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          error: "User not found",
        });
        return;
      }

      // Check if the job exists and belongs to the user
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

      if (job.userId !== userIdToUse) {
        res.status(403).json({
          success: false,
          error: "You don't have permission to download this video",
        });
        return;
      }

      // Check if the user has already downloaded this video
      const existingDownloads = user.videoDownloads;
      if (existingDownloads.length > 0) {
        res.status(200).json({
          success: true,
          message: "Video download already tracked",
          data: {
            userId: userIdToUse,
            jobId,
            templateKey,
            timestamp: existingDownloads[0].createdAt.toISOString(),
          },
        });
        return;
      }

      // Check download limits based on subscription tier
      const maxDownloads = user.currentTier?.maxReelDownloads;

      if (maxDownloads !== undefined && maxDownloads !== null) {
        const downloadCount = await prisma.videoDownload.count({
          where: {
            userId: userIdToUse,
          },
        });

        if (downloadCount >= maxDownloads) {
          res.status(403).json({
            success: false,
            error:
              "You have reached your download limit for this subscription tier",
            data: {
              currentDownloads: downloadCount,
              maxDownloads,
              tier: user.currentTier?.name,
            },
          });
          return;
        }
      }

      // Track the download
      const download = await prisma.videoDownload.create({
        data: {
          userId: userIdToUse,
          jobId,
          templateKey,
        },
      });

      logger.info("Video download tracked successfully", {
        userId: userIdToUse,
        jobId,
        templateKey,
        tier: user.currentTier?.name || "unknown",
        maxDownloads,
        downloadId: download.id,
      });

      // Return success response
      res.status(200).json({
        success: true,
        message: "Video download tracked successfully",
        data: {
          userId: userIdToUse,
          jobId,
          templateKey,
          timestamp: download.createdAt.toISOString(),
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

// Add a new endpoint to get the user's download count
router.get("/download-count", isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    // Get the user's download count
    const downloadCount = await prisma.videoDownload.count({
      where: {
        userId,
      },
    });

    // Get the user's subscription tier
    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        currentTier: true,
      },
    });

    const maxDownloads = user?.currentTier?.maxReelDownloads || 1;

    res.status(200).json({
      success: true,
      data: {
        downloadCount,
        maxDownloads,
        remainingDownloads: Math.max(0, maxDownloads - downloadCount),
      },
    });
  } catch (error) {
    logger.error("Error getting download count", { error });
    res.status(500).json({
      success: false,
      error: "Failed to get download count",
    });
  }
});

export { router as videosRouter };
