#!/usr/bin/env node

/**
 * This script checks the production webhook configuration by making a request
 * to the Clerk API to get the webhook endpoints and their secrets.
 *
 * Usage:
 * CLERK_SECRET_KEY=your_clerk_secret_key node scripts/check-production-webhook.js
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import path from "path";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

if (!CLERK_SECRET_KEY) {
  console.error(
    "❌ ERROR: CLERK_SECRET_KEY is not set in your environment variables"
  );
  console.error("Please run the script with:");
  console.error(
    "CLERK_SECRET_KEY=your_clerk_secret_key node scripts/check-production-webhook.js"
  );
  process.exit(1);
}

console.log("\n🔍 Clerk Production Webhook Check Tool 🔍\n");

async function checkWebhooks() {
  try {
    // Get the instance ID from the secret key
    const instanceId = CLERK_SECRET_KEY.split("_")[1];

    if (!instanceId) {
      console.error("❌ Could not extract instance ID from CLERK_SECRET_KEY");
      process.exit(1);
    }

    console.log(`Using Clerk instance: ${instanceId}`);

    // Make a request to the Clerk API to get the webhooks
    const response = await fetch(`https://api.clerk.com/v1/webhooks`, {
      headers: {
        Authorization: `Bearer ${CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        `❌ Failed to get webhooks: ${response.status} ${response.statusText}`
      );
      const text = await response.text();
      console.error(text);
      process.exit(1);
    }

    const webhooks = await response.json();

    if (!webhooks.data || webhooks.data.length === 0) {
      console.log("⚠️ No webhooks found for this Clerk instance");
      console.log("You need to create a webhook in the Clerk dashboard:");
      console.log("https://dashboard.clerk.dev/");
      process.exit(0);
    }

    console.log(`Found ${webhooks.data.length} webhook(s):\n`);

    for (const webhook of webhooks.data) {
      console.log(`Webhook ID: ${webhook.id}`);
      console.log(`URL: ${webhook.url}`);
      console.log(
        `Events: ${
          webhook.subscribe_to_all_events
            ? "All events"
            : webhook.subscribed_events.join(", ")
        }`
      );
      console.log(`Active: ${webhook.active ? "✅ Yes" : "❌ No"}`);

      // Get the signing secret for this webhook
      const secretResponse = await fetch(
        `https://api.clerk.com/v1/webhooks/${webhook.id}/secret`,
        {
          headers: {
            Authorization: `Bearer ${CLERK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (secretResponse.ok) {
        const secretData = await secretResponse.json();
        if (secretData.secret) {
          const secret = secretData.secret;
          console.log(
            `Signing Secret: ${secret.substring(0, 5)}...${secret.substring(
              secret.length - 5
            )}`
          );

          // Check if it matches the local environment variable
          const localSecret = process.env.CLERK_WEBHOOK_SECRET;
          if (localSecret) {
            if (secret === localSecret) {
              console.log(
                `✅ Local CLERK_WEBHOOK_SECRET matches this webhook's secret`
              );
            } else {
              console.log(
                `❌ Local CLERK_WEBHOOK_SECRET does NOT match this webhook's secret`
              );
              console.log(
                `Local: ${localSecret.substring(
                  0,
                  5
                )}...${localSecret.substring(localSecret.length - 5)}`
              );
              console.log(
                `Clerk: ${secret.substring(0, 5)}...${secret.substring(
                  secret.length - 5
                )}`
              );
            }
          } else {
            console.log(`⚠️ Local CLERK_WEBHOOK_SECRET is not set`);
          }
        } else {
          console.log(`⚠️ Could not retrieve signing secret`);
        }
      } else {
        console.log(
          `⚠️ Could not retrieve signing secret: ${secretResponse.status} ${secretResponse.statusText}`
        );
      }

      console.log("---");
    }

    console.log("\n📝 Recommendations:");
    console.log(
      "1. Ensure the webhook URL points to your production backend: https://reelty-backend-production.up.railway.app/webhooks/clerk"
    );
    console.log("2. Make sure the webhook is active");
    console.log(
      "3. Verify that the signing secret in your production environment matches the one in Clerk"
    );
    console.log(
      "4. Check that the webhook is subscribed to the user.created event"
    );
  } catch (error) {
    console.error("❌ Error checking webhooks:", error.message);
  }
}

checkWebhooks();
