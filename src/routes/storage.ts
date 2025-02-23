import { Router, Request, Response } from "express";
import { StorageService } from "../services/storage.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { isAuthenticated } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";

const router = Router();
const storageService = StorageService.getInstance();

// Validation schemas
const uploadRequestSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    type: z.enum(["image", "video", "document"]),
    contentType: z.string().min(1),
    propertyId: z.string().uuid(),
  }),
});

// Generate upload URL
router.post(
  "/upload",
  isAuthenticated,
  validateRequest(uploadRequestSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { name, type, contentType, propertyId } = req.body;

      // Verify property belongs to user
      const property = await prisma.listing.findUnique({
        where: {
          id: propertyId,
          userId,
        },
      });

      if (!property) {
        logger.error("[Storage] Property not found or access denied", {
          propertyId,
          userId,
        });
        res.status(404).json({
          success: false,
          error: "Property not found or access denied",
        });
        return;
      }

      const result = await storageService.uploadPropertyMedia(propertyId, {
        name,
        type,
        contentType,
      });

      logger.info("[Storage] Generated upload URL", {
        propertyId,
        userId,
        type,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error("[Storage] Upload URL generation error", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Get download URL
router.get(
  "/download/:propertyId/:fileKey",
  isAuthenticated,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { propertyId, fileKey } = req.params;

      // Verify property belongs to user
      const property = await prisma.listing.findUnique({
        where: {
          id: propertyId,
          userId,
        },
      });

      if (!property) {
        logger.error("[Storage] Property not found or access denied", {
          propertyId,
          userId,
        });
        res.status(404).json({
          success: false,
          error: "Property not found or access denied",
        });
        return;
      }

      const downloadUrl = await storageService.getSignedUrl(fileKey);

      logger.info("[Storage] Generated download URL", {
        propertyId,
        userId,
        fileKey,
      });

      res.status(200).json({
        success: true,
        data: { downloadUrl },
      });
    } catch (error) {
      logger.error("[Storage] Download URL generation error", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Delete file
router.delete(
  "/file/:propertyId/:fileKey",
  isAuthenticated,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { propertyId, fileKey } = req.params;

      // Verify property belongs to user
      const property = await prisma.listing.findUnique({
        where: {
          id: propertyId,
          userId,
        },
      });

      if (!property) {
        logger.error("[Storage] Property not found or access denied", {
          propertyId,
          userId,
        });
        res.status(404).json({
          success: false,
          error: "Property not found or access denied",
        });
        return;
      }

      await storageService.deleteFile(fileKey);

      logger.info("[Storage] Deleted file", {
        propertyId,
        userId,
        fileKey,
      });

      res.status(200).json({
        success: true,
        message: "File deleted successfully",
      });
    } catch (error) {
      logger.error("[Storage] File deletion error", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

console.log("AWS Config:", {
  bucket: process.env.AWS_BUCKET,
  region: process.env.AWS_REGION,
  // Don't log the full access key/secret, just the first few chars
  accessKeyId: process.env.AWS_ACCESS_KEY_ID?.substring(0, 5),
  hasSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
});

export default router;
