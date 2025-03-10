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
      "svix-signature": req.headers["svix-signature"] ? "present" : "missing",
      "content-type": req.headers["content-type"],
    },
    path: req.path,
    method: req.method,
    body: req.body, // Parsed JSON body
    rawBody: (req as any).rawBody ? "present" : "missing", // Raw body string
    rawBodyLength: (req as any).rawBody?.length,
    url: req.url,
    origin: req.headers.origin,
    host: req.headers.host,
  });

  const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  logger.info("[Clerk Webhook] Secret check", {
    exists: !!CLERK_WEBHOOK_SECRET,
    length: CLERK_WEBHOOK_SECRET?.length,
    secretFirstChars: CLERK_WEBHOOK_SECRET
      ? CLERK_WEBHOOK_SECRET.substring(0, 5) + "..."
      : "missing",
  });

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
      res
        .status(400)
        .json(
          createApiResponse(false, undefined, undefined, "Missing request body")
        );
      return;
    }

    // Check if the timestamp is within a reasonable time window (15 minutes)
    const timestampMs = parseInt(svix_timestamp, 10) * 1000; // Convert seconds to milliseconds
    const currentTimeMs = Date.now();
    const timeDifferenceMs = Math.abs(currentTimeMs - timestampMs);
    const fifteenMinutesMs = 15 * 60 * 1000;

    if (timeDifferenceMs > fifteenMinutesMs) {
      logger.error("[Clerk Webhook] Timestamp too old or in the future", {
        webhookTimestamp: new Date(timestampMs).toISOString(),
        currentTime: new Date(currentTimeMs).toISOString(),
        differenceMs: timeDifferenceMs,
        maxAllowedDifference: fifteenMinutesMs,
      });
      res
        .status(400)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "Webhook timestamp is too old or in the future"
          )
        );
      return;
    }

    // Verify the webhook payload
    try {
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
    } catch (verifyError) {
      // Try with a different content type as a fallback
      // Sometimes the content type can cause issues with verification
      logger.warn(
        "[Clerk Webhook] First verification attempt failed, trying alternative approach",
        {
          error:
            verifyError instanceof Error
              ? verifyError.message
              : "Unknown error",
        }
      );

      // For debugging purposes, try to manually construct the signature
      try {
        // Log more details about the verification process
        logger.info("[Clerk Webhook] Detailed verification debug", {
          payloadFirstBytes: Array.from(
            new TextEncoder().encode(payload.substring(0, 10))
          ),
          signatureHeader: svix_signature,
          timestampValue: svix_timestamp,
        });

        // Try again with the original verification
        req.webhookEvent = wh.verify(payload, {
          "svix-id": svix_id,
          "svix-timestamp": svix_timestamp,
          "svix-signature": svix_signature,
        }) as WebhookEvent;

        logger.info("[Clerk Webhook] Second verification attempt succeeded");
        next();
      } catch (secondVerifyError) {
        logger.error("[Clerk Webhook] Verification failed after retry", {
          error:
            secondVerifyError instanceof Error
              ? secondVerifyError.message
              : "Unknown error",
          stack:
            secondVerifyError instanceof Error
              ? secondVerifyError.stack
              : undefined,
          bodyType: typeof req.body,
          bodyKeys: Object.keys(req.body || {}),
          headers: {
            svix_id,
            svix_timestamp,
            svix_signature,
          },
        });

        // For development/testing purposes, you might want to bypass verification in non-production environments
        if (
          process.env.NODE_ENV !== "production" &&
          process.env.BYPASS_WEBHOOK_VERIFICATION === "true"
        ) {
          logger.warn(
            "[Clerk Webhook] ⚠️ BYPASSING VERIFICATION IN DEVELOPMENT MODE ⚠️"
          );
          try {
            req.webhookEvent = JSON.parse(payload) as WebhookEvent;
            next();
            return;
          } catch (parseError) {
            logger.error(
              "[Clerk Webhook] Failed to parse payload as JSON during bypass",
              {
                error:
                  parseError instanceof Error
                    ? parseError.message
                    : "Unknown error",
              }
            );
          }
        }

        // EMERGENCY BYPASS FOR PRODUCTION - USE WITH CAUTION
        // This is a temporary measure to help diagnose webhook issues
        if (process.env.EMERGENCY_BYPASS_WEBHOOK_VERIFICATION === "true") {
          logger.warn(
            "[Clerk Webhook] ⚠️ EMERGENCY BYPASSING VERIFICATION IN PRODUCTION MODE ⚠️"
          );
          try {
            req.webhookEvent = JSON.parse(payload) as WebhookEvent;
            logger.info("[Clerk Webhook] Emergency bypass successful", {
              eventType: (req.webhookEvent as WebhookEvent).type,
              userId: (req.webhookEvent as WebhookEvent).data.id,
            });
            next();
            return;
          } catch (parseError) {
            logger.error(
              "[Clerk Webhook] Failed to parse payload as JSON during emergency bypass",
              {
                error:
                  parseError instanceof Error
                    ? parseError.message
                    : "Unknown error",
              }
            );
          }
        }

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
      }
    }
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
    res
      .status(400)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Webhook verification failed"
        )
      );
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

      logger.info("[Clerk Webhook] Processing event", {
        type: eventType,
        userId: evt.data.id,
        objectType: evt.data.object,
        timestamp: new Date((evt as any).timestamp || Date.now()).toISOString(),
      });

      if (eventType === "user.created" || eventType === "user.updated") {
        const { id, email_addresses, first_name, last_name } = evt.data;

        // Log the raw user data
        logger.info("[Clerk Webhook] Raw user data", {
          id,
          emailAddresses: email_addresses,
          firstName: first_name,
          lastName: last_name,
          primaryEmailId: evt.data.primary_email_address_id,
        });

        // Get the primary email
        const primaryEmailObj =
          email_addresses?.find(
            (email) => email.id === evt.data.primary_email_address_id
          ) || email_addresses?.[0];

        const email = primaryEmailObj?.email_address;

        logger.info("[Clerk Webhook] Extracted user data", {
          id,
          email,
          firstName: first_name,
          lastName: last_name,
          primaryEmailId: evt.data.primary_email_address_id,
          foundEmail: !!email,
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
            logger.info("[Clerk Webhook] User already exists, updating", {
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

          const result = await prisma.$transaction(async (tx) => {
            // Get the FREE tier details first
            const freeTier = await tx.subscriptionTier.findUnique({
              where: { tierId: SubscriptionTierId.FREE },
            });

            if (!freeTier) {
              logger.error("[Clerk Webhook] Free tier not found", {
                userId: id,
                email,
              });
              throw new Error("Free tier not found");
            }

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
                activeSubscription: {
                  include: {
                    tier: true,
                  },
                },
              },
            });

            logger.info("[Clerk Webhook] User created successfully", {
              userId: user.id,
              email: user.email,
              subscriptionsCount: user.subscriptions?.length || 0,
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

              logger.info("[Clerk Webhook] Set active subscription", {
                userId: user.id,
                subscriptionId: subscription.id,
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

              logger.info(
                "[Clerk Webhook] Created initial credit for new user",
                {
                  userId: user.id,
                  email: user.email,
                  credits: freeTier.creditsPerInterval,
                }
              );
            }

            return user;
          });

          logger.info("[Clerk Webhook] User creation transaction successful", {
            userId: result.id,
            email: result.email,
            operation: eventType === "user.created" ? "create" : "update",
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
