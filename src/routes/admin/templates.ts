import { PrismaClient } from "@prisma/client";
import express, { RequestHandler } from "express";
import { z } from "zod";
import { isAdmin } from "../../middleware/auth";
import { validateRequest } from "../../middleware/validate";

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const templateSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    thumbnailUrl: z.string().optional(),
    tiers: z.array(z.string()),
    order: z.number().optional(),
  }),
});

const templateReorderSchema = z.object({
  body: z.object({
    templates: z.array(
      z.object({
        id: z.string(),
        order: z.number(),
      })
    ),
  }),
});

// Apply admin middleware to all routes
router.use(isAdmin);

// Template handlers
const getTemplates: RequestHandler = async (_req, res) => {
  try {
    const templates = await prisma.template.findMany({
      orderBy: {
        order: "asc",
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

const createTemplate: RequestHandler = async (req, res) => {
  try {
    const lastTemplate = await prisma.template.findFirst({
      orderBy: {
        order: "desc",
      },
    });

    const template = await prisma.template.create({
      data: {
        ...req.body,
        order: lastTemplate ? lastTemplate.order + 1 : 1,
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

const reorderTemplates: RequestHandler = async (req, res) => {
  try {
    const { templates } = req.body;

    // Use a transaction to ensure all updates succeed or none do
    await prisma.$transaction(
      templates.map((template: { id: string; order: number }) =>
        prisma.template.update({
          where: { id: template.id },
          data: { order: template.order },
        })
      )
    );

    const updatedTemplates = await prisma.template.findMany({
      orderBy: {
        order: "asc",
      },
    });

    res.json({
      success: true,
      data: updatedTemplates,
    });
  } catch (error) {
    console.error("Reorder templates error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Register routes
router.get("/", getTemplates);
router.post("/", validateRequest(templateSchema), createTemplate);
router.put(
  "/reorder",
  validateRequest(templateReorderSchema),
  reorderTemplates
);

export default router;
