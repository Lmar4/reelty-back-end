import { Router, Request, Response } from "express";
import { StorageService } from "../services/storage";

import { z } from "zod";
import { validateRequest } from "../middleware/validate";

const router = Router();
const storageService = StorageService.getInstance();

// Validation schemas
const uploadRequestSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    type: z.enum(["image", "video", "document"]),
    contentType: z.string().min(1),
    propertyId: z.string().min(1),
  }),
});

// Test upload URL generation
router.post(
  "/test/upload",
  validateRequest(uploadRequestSchema),
  async (req: Request, res: Response) => {
    try {
      const { name, type, contentType, propertyId } = req.body;

      const result = await storageService.uploadPropertyMedia(propertyId, {
        name,
        type,
        contentType,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("Storage test upload error:", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

// Test download URL generation
router.get("/test/download/:fileKey", async (req: Request, res: Response) => {
  try {
    const { fileKey } = req.params;
    const downloadUrl = await storageService.getDownloadUrl(fileKey);

    res.status(200).json({
      success: true,
      data: { downloadUrl },
    });
  } catch (error) {
    console.error("Storage test download error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// Test file deletion
router.delete("/test/file/:fileKey", async (req: Request, res: Response) => {
  try {
    const { fileKey } = req.params;
    await storageService.deleteFile(fileKey);

    res.status(200).json({
      success: true,
      message: "File deleted successfully",
    });
  } catch (error) {
    console.error("Storage test deletion error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

export default router;
