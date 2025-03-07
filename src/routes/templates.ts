import express, { RequestHandler } from "express";
import { z } from "zod";
import {
  getTierNameFromId,
  isValidTierId,
  SubscriptionTierId,
  SUBSCRIPTION_TIERS,
} from "../constants/subscription-tiers.js";
import { prisma } from "../lib/prisma.js";
import { isAuthenticated } from "../middleware/auth.js";
import { validateRequest } from "../middleware/validate.js";
import { logger } from "../utils/logger.js";
import { createApiResponse } from "../types/api.js";
const router = express.Router();

// Validation schemas
const templateSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    subscriptionTierIds: z
      .array(z.string())
      .refine((ids) => ids.every(isValidTierId), {
        message: "Invalid subscription tier ID provided",
      }),
    order: z.number().default(0),
    key: z.string().min(1),
    sequence: z.array(z.unknown()),
    durations: z.array(z.unknown()),
  }),
});

// Schema for query parameters
const GetTemplatesQuerySchema = z.object({
  tierId: z.string().refine((val) => {
    // Check if it's a valid UUID format tier ID
    if (isValidTierId(val)) return true;
    // Check if it's a valid tier name (case insensitive)
    const upperVal = val.toUpperCase();
    return Object.keys(SUBSCRIPTION_TIERS).includes(upperVal);
  }, "Invalid subscription tier ID"),
});

// Get templates by subscription tier
const getTemplates: RequestHandler = async (req, res) => {
  try {
    const { tierId } = GetTemplatesQuerySchema.parse(req.query);

    // Convert tier name to ID if necessary
    const actualTierId = isValidTierId(tierId)
      ? tierId
      : SUBSCRIPTION_TIERS[
          tierId.toUpperCase() as keyof typeof SUBSCRIPTION_TIERS
        ];

    const templates = await prisma.template.findMany({
      where: {
        subscriptionTiers: {
          some: {
            id: actualTierId,
          },
        },
      },
      include: {
        subscriptionTiers: true,
      },
      orderBy: {
        order: "asc",
      },
    });

    if (!isValidTierId(tierId)) {
      res
        .status(400)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "Invalid subscription tier ID"
          )
        );
      return;
    }

    res.json(
      createApiResponse(true, {
        templates,
        pagination: {
          total: templates.length,
          page: 1,
          limit: templates.length,
        },
      })
    );
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error ? error.message : "Failed to fetch templates"
        )
      );
  }
};

// Create template
const createTemplate: RequestHandler = async (req, res) => {
  try {
    const {
      name,
      description,
      order,
      subscriptionTierIds,
      key,
      sequence,
      durations,
    } = req.body;

    // Validate subscription tier IDs
    if (!subscriptionTierIds.every(isValidTierId)) {
      res.status(400).json({
        success: false,
        error: "Invalid subscription tier ID provided",
      });
      return;
    }

    const validTierIds = subscriptionTierIds as SubscriptionTierId[];

    // Create template and connect subscription tiers in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create the template
      const template = await tx.template.create({
        data: {
          name,
          description,
          order: order || 0,
          tiers: validTierIds.map(getTierNameFromId),
          key,
          sequence,
          durations,
          subscriptionTiers: {
            connect: validTierIds.map((id) => ({ id })),
          },
        },
        include: {
          subscriptionTiers: true,
        },
      });

      return template;
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error("Create template error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Get all templates with subscription tiers
router.get("/", isAuthenticated, async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      include: {
        subscriptionTiers: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        order: "asc",
      },
    });

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    logger.error("[GET_TEMPLATES_ERROR]", error);
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to fetch templates",
    });
  }
});

// Route handlers
router.get("/", isAuthenticated, getTemplates);
router.post(
  "/",
  isAuthenticated,
  validateRequest(templateSchema),
  createTemplate
);

export default router;
