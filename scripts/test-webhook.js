#!/usr/bin/env node

/**
 * This script tests the webhook endpoint by sending a simulated user.created event
 * with a valid signature.
 *
 * Usage:
 * node scripts/test-webhook.js
 */

import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import path from "path";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../.env") });

console.log("\n🔍 Clerk Webhook Test Tool 🔍\n");

const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3001";

if (!CLERK_WEBHOOK_SECRET) {
  console.error(
    "❌ ERROR: CLERK_WEBHOOK_SECRET is not set in your environment variables"
  );
  console.error("Please set it in your .env file or environment variables");
  process.exit(1);
}

// Create a test user.created event payload
const testPayload = JSON.stringify({
  data: {
    id: "user_test_" + Date.now(),
    email_addresses: [
      {
        email_address: "test@example.com",
        id: "idn_test_" + Date.now(),
      },
    ],
    first_name: "Test",
    last_name: "User",
    primary_email_address_id: "idn_test_" + Date.now(),
  },
  type: "user.created",
  object: "event",
  timestamp: Date.now(),
});

// Generate a timestamp and message ID for the webhook
const timestamp = Math.floor(Date.now() / 1000).toString();
const messageId = crypto.randomBytes(16).toString("hex");

// Create a signature
const toSign = `${timestamp}.${messageId}.${testPayload}`;
const signature = crypto
  .createHmac("sha256", CLERK_WEBHOOK_SECRET)
  .update(toSign)
  .digest("hex");

// Headers for the webhook request
const headers = {
  "Content-Type": "application/json",
  "svix-id": messageId,
  "svix-timestamp": timestamp,
  "svix-signature": `v1,${signature}`,
};

async function testWebhook() {
  console.log(`Sending test webhook to: ${SERVER_URL}/webhooks/clerk`);
  console.log("Headers:", JSON.stringify(headers, null, 2));
  console.log("Payload sample:", testPayload.substring(0, 100) + "...");

  try {
    const response = await fetch(`${SERVER_URL}/webhooks/clerk`, {
      method: "POST",
      headers: headers,
      body: testPayload,
    });

    const responseText = await response.text();

    console.log(`\nResponse status: ${response.status}`);
    console.log("Response body:", responseText);

    if (response.ok) {
      console.log("\n✅ Webhook test successful!");
    } else {
      console.log("\n❌ Webhook test failed!");
    }
  } catch (error) {
    console.error("\n❌ Error sending webhook:", error.message);
  }
}

testWebhook();
