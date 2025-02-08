import express, { RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { getAuth } from "@clerk/express";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const templateSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    sequence: z.any(),
    durations: z.any(),
    musicPath: z.string().optional(),
    musicVolume: z.number().optional(),
    subscriptionTier: z.string().min(1),
    isActive: z.boolean().optional(),
  }),
});

// Get templates by subscription tier
const getTemplates: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { tier } = req.query;
    if (!tier) {
      res.status(400).json({
        success: false,
        error: "Subscription tier is required",
      });
      return;
    }

    const templates = await prisma.template.findMany({
      where: {
        subscriptionTier: tier as string,
        isActive: true,
      },
      include: {
        tier: true,
      },
    });

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    console.error("Get templates error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Create template
const createTemplate: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const template = await prisma.template.create({
      data: {
        ...req.body,
        isActive: req.body.isActive ?? true,
      },
      include: {
        tier: true,
      },
    });

    res.status(201).json({
      success: true,
      data: template,
    });
  } catch (error) {
    console.error("Create template error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.get("/", getTemplates);
router.post("/", validateRequest(templateSchema), createTemplate);

export default router;
