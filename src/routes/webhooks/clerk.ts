import express from "express";
import { Webhook } from "svix";
import { WebhookEvent } from "@clerk/backend";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../utils/logger.js";

const router = express.Router();

// Extend Express Request type to include webhookEvent
declare global {
  namespace Express {
    interface Request {
      webhookEvent?: WebhookEvent;
      rawBody?: string;
    }
  }
}

// Validation middleware for Clerk webhooks
const validateClerkWebhook = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Log complete request details
  logger.info("[Clerk Webhook] Received webhook request", {
    headers: {
      ...req.headers,
      // Log specific headers we care about
      "svix-id": req.headers["svix-id"],
      "svix-timestamp": req.headers["svix-timestamp"],
      "svix-signature": req.headers["svix-signature"],
      "content-type": req.headers["content-type"],
    },
    path: req.path,
    method: req.method,
    body: req.body, // Parsed JSON body
    rawBody: (req as any).rawBody, // Raw body string
  });

  const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!CLERK_WEBHOOK_SECRET) {
    logger.error("[Clerk Webhook] Missing CLERK_WEBHOOK_SECRET");
    res.status(500).json({
      success: false,
      error: "Server configuration error",
    });
    return;
  }

  // Get the headers
  const svix_id = req.headers["svix-id"] as string;
  const svix_timestamp = req.headers["svix-timestamp"] as string;
  const svix_signature = req.headers["svix-signature"] as string;

  logger.info("[Clerk Webhook] Validating headers", {
    svix_id: svix_id ? "present" : "missing",
    svix_timestamp: svix_timestamp ? "present" : "missing",
    svix_signature: svix_signature ? "present" : "missing",
  });

  // If there are no headers, error out
  if (!svix_id || !svix_timestamp || !svix_signature) {
    logger.error("[Clerk Webhook] Missing svix headers", {
      svix_id,
      svix_timestamp,
      svix_signature,
    });
    res.status(400).json({
      success: false,
      error: "Missing svix headers",
    });
    return;
  }

  try {
    const wh = new Webhook(CLERK_WEBHOOK_SECRET);

    // Use the raw body for verification
    const payload = (req as any).rawBody;

    logger.info("[Clerk Webhook] Verification attempt details", {
      payloadLength: payload?.length,
      payloadSample: payload?.substring(0, 100), // Log first 100 chars
      headers: {
        svix_id,
        svix_timestamp,
        svix_signature,
      },
      secretLength: CLERK_WEBHOOK_SECRET.length,
      secretPrefix: CLERK_WEBHOOK_SECRET.substring(0, 5) + "...", // Log first 5 chars for verification
    });

    if (!payload) {
      logger.error("[Clerk Webhook] Missing request body");
      res.status(400).json({
        success: false,
        error: "Missing request body",
      });
      return;
    }

    // Verify the webhook payload
    req.webhookEvent = wh.verify(payload, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    }) as WebhookEvent;

    logger.info("[Clerk Webhook] Payload verified successfully", {
      eventType: (req.webhookEvent as WebhookEvent).type,
      userId: (req.webhookEvent as WebhookEvent).data.id,
    });

    next();
  } catch (err) {
    logger.error("[Clerk Webhook] Verification failed", {
      error: err instanceof Error ? err.message : "Unknown error",
      stack: err instanceof Error ? err.stack : undefined,
      bodyType: typeof req.body,
      bodyKeys: Object.keys(req.body || {}),
      headers: {
        svix_id,
        svix_timestamp,
        svix_signature,
      },
    });
    res.status(400).json({
      success: false,
      error: "Webhook verification failed",
    });
    return;
  }
};

// Handle user creation and updates
router.post(
  "/",
  validateClerkWebhook,
  async (req: express.Request, res: express.Response) => {
    try {
      const evt = req.webhookEvent as WebhookEvent;
      const eventType = evt.type;

      logger.info(`[Clerk Webhook] Processing ${eventType} event`);

      if (eventType === "user.created" || eventType === "user.updated") {
        const { id, email_addresses, first_name, last_name } = evt.data;
        const email = email_addresses?.[0]?.email_address;

        if (!email) {
          logger.error("[Clerk Webhook] No email address found in user data");
          res.status(400).json({
            success: false,
            error: "No email address found",
          });
          return;
        }

        const user = await prisma.user.upsert({
          where: { id: id as string },
          update: {
            email,
            firstName: first_name || null,
            lastName: last_name || null,
          },
          create: {
            id: id as string,
            email,
            firstName: first_name || null,
            lastName: last_name || null,
            password: "", // Empty password since we're using Clerk
            role: "USER",
            subscriptionStatus: "TRIALING",
          },
        });

        logger.info("[Clerk Webhook] User processed successfully", {
          userId: user.id,
          event: eventType,
        });

        res.status(200).json({
          success: true,
          data: user,
        });
        return;
      } else if (eventType === "user.deleted") {
        const { id } = evt.data;

        await prisma.user.delete({
          where: { id: id as string },
        });

        logger.info("[Clerk Webhook] User deleted successfully", {
          userId: id,
        });

        res.status(200).json({
          success: true,
          message: "User deleted successfully",
        });
        return;
      }

      // Handle other event types if needed
      res.status(200).json({
        success: true,
        message: "Event processed",
      });
      return;
    } catch (error) {
      logger.error("[Clerk Webhook] Error processing webhook", error);
      res.status(500).json({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
      return;
    }
  }
);

export default router;
