import { WebhookEvent } from "@clerk/backend";
import { SubscriptionTierId } from "@prisma/client";
import express from "express";
import { Webhook } from "svix";
import { prisma } from "../../lib/prisma.js";
import { createApiResponse } from "../../types/api.js";
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

// Simplified validation middleware for Clerk webhooks
const validateClerkWebhook = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Log basic request info
  logger.info("[Clerk Webhook] Received webhook request", {
    path: req.path,
    method: req.method,
    contentType: req.headers["content-type"],
  });

  // Get the webhook secret
  const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!CLERK_WEBHOOK_SECRET) {
    logger.error("[Clerk Webhook] Missing CLERK_WEBHOOK_SECRET");
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Server configuration error: Missing webhook secret"
        )
      );
    return; // Return without a value
  }

  // Get the headers
  const svix_id = req.headers["svix-id"] as string;
  const svix_timestamp = req.headers["svix-timestamp"] as string;
  const svix_signature = req.headers["svix-signature"] as string;

  // If there are no headers, error out
  if (!svix_id || !svix_timestamp || !svix_signature) {
    logger.error("[Clerk Webhook] Missing svix headers", {
      svix_id: svix_id || "missing",
      svix_timestamp: svix_timestamp || "missing",
      svix_signature: svix_signature || "missing",
    });
    res
      .status(400)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Missing required webhook headers"
        )
      );
    return; // Return without a value
  }

  // Get the raw body
  const payload = (req as any).rawBody;

  if (!payload) {
    logger.error("[Clerk Webhook] Missing request body");
    res
      .status(400)
      .json(
        createApiResponse(false, undefined, undefined, "Missing request body")
      );
    return; // Return without a value
  }

  try {
    const wh = new Webhook(CLERK_WEBHOOK_SECRET);

    // Verify the webhook payload
    req.webhookEvent = wh.verify(payload, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    }) as WebhookEvent;

    logger.info("[Clerk Webhook] Payload verified successfully", {
      eventType: req.webhookEvent.type,
      userId: req.webhookEvent.data.id,
    });

    next();
  } catch (err) {
    logger.error("[Clerk Webhook] Verification failed", {
      error: err instanceof Error ? err.message : "Unknown error",
      payloadSample: payload.substring(0, 100) + "...", // Log first 100 chars
    });

    res
      .status(400)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Webhook verification failed: Invalid signature"
        )
      );
    // No return value
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

      logger.info("[Clerk Webhook] Processing event", {
        type: eventType,
        userId: evt.data.id,
        objectType: evt.data.object,
      });

      if (eventType === "user.created" || eventType === "user.updated") {
        const { id, email_addresses, first_name, last_name } = evt.data;

        // Get the primary email
        const primaryEmailObj =
          email_addresses?.find(
            (email) => email.id === evt.data.primary_email_address_id
          ) || email_addresses?.[0];

        const email = primaryEmailObj?.email_address;

        logger.info("[Clerk Webhook] User data", {
          id,
          email,
          firstName: first_name,
          lastName: last_name,
          primaryEmailId: evt.data.primary_email_address_id,
        });

        if (!email) {
          logger.error("[Clerk Webhook] No email address found", {
            availableEmails: email_addresses?.map((e) => e.email_address),
            userId: id,
          });
          res
            .status(400)
            .json(
              createApiResponse(
                false,
                undefined,
                undefined,
                "No email address found"
              )
            );
          return;
        }

        try {
          // First check if the user already exists
          const existingUser = await prisma.user.findUnique({
            where: { id: id as string },
          });

          if (existingUser) {
            logger.info("[Clerk Webhook] Updating existing user", {
              userId: id,
              email,
            });

            // Update the user
            const updatedUser = await prisma.user.update({
              where: { id: id as string },
              data: {
                email,
                firstName: first_name || null,
                lastName: last_name || null,
              },
            });

            logger.info("[Clerk Webhook] User updated successfully", {
              userId: updatedUser.id,
              email: updatedUser.email,
            });

            res.status(200).json(createApiResponse(true, updatedUser));
            return;
          }

          // User doesn't exist, create a new one
          logger.info("[Clerk Webhook] Creating new user", {
            userId: id,
            email,
          });

          // Get the FREE tier details first
          const freeTier = await prisma.subscriptionTier.findUnique({
            where: { tierId: SubscriptionTierId.FREE },
          });

          if (!freeTier) {
            logger.error("[Clerk Webhook] Free tier not found");
            res
              .status(500)
              .json(
                createApiResponse(
                  false,
                  undefined,
                  undefined,
                  "Free tier not found"
                )
              );
            return;
          }

          // Create the user with a transaction
          const result = await prisma.$transaction(async (tx) => {
            // Create the user
            const user = await tx.user.create({
              data: {
                id: id as string,
                email: email,
                firstName: first_name || null,
                lastName: last_name || null,
                password: "",
                role: "USER",
                subscriptions: {
                  create: {
                    tierId: SubscriptionTierId.FREE,
                    status: "TRIALING",
                  },
                },
              },
              include: {
                subscriptions: true,
              },
            });

            // Set the active subscription reference
            if (user.subscriptions && user.subscriptions.length > 0) {
              const subscription = user.subscriptions[0];
              await tx.user.update({
                where: { id: user.id },
                data: {
                  activeSubscriptionId: subscription.id,
                },
              });
            }

            // Only create initial credit for new users (not updates)
            if (eventType === "user.created") {
              await tx.listingCredit.create({
                data: {
                  userId: user.id,
                  creditsRemaining: freeTier.creditsPerInterval,
                },
              });

              // Log the credit creation
              await tx.creditLog.create({
                data: {
                  userId: user.id,
                  amount: freeTier.creditsPerInterval,
                  reason: `Initial trial credit (${freeTier.name})`,
                },
              });
            }

            return user;
          });

          logger.info("[Clerk Webhook] User creation successful", {
            userId: result.id,
            email: result.email,
          });

          res.status(200).json(createApiResponse(true, result));
          return;
        } catch (error) {
          logger.error("[Clerk Webhook] Database operation failed", {
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
            userData: { id, email, firstName: first_name, lastName: last_name },
          });
          throw error;
        }
      } else if (eventType === "user.deleted") {
        const { id } = evt.data;

        try {
          // First check if the user exists
          const user = await prisma.user.findUnique({
            where: { id: id as string },
          });

          if (!user) {
            logger.info("[Clerk Webhook] User already deleted or not found", {
              userId: id,
            });
            res
              .status(200)
              .json(
                createApiResponse(
                  true,
                  undefined,
                  "User already deleted or not found"
                )
              );
            return;
          }

          // If user exists, delete them
          await prisma.user.delete({
            where: { id: id as string },
          });

          logger.info("[Clerk Webhook] User deleted successfully", {
            userId: id,
          });

          res
            .status(200)
            .json(
              createApiResponse(true, undefined, "User deleted successfully")
            );
          return;
        } catch (error) {
          logger.error("[Clerk Webhook] Error deleting user", {
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
            userId: id,
          });
          throw error;
        }
      }

      // Handle other event types if needed
      res.status(200).json(createApiResponse(true, null, "Event processed"));
    } catch (error) {
      logger.error("[Clerk Webhook] Error processing webhook", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        eventType: req.webhookEvent?.type || "unknown",
        userId: req.webhookEvent?.data?.id || "unknown",
      });

      res
        .status(500)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            error instanceof Error ? error.message : "Failed to process webhook"
          )
        );
    }
  }
);

export default router;
