#!/usr/bin/env node

/**
 * This script tests the Clerk webhook by sending a simulated user.created event
 * to your local server. It helps diagnose issues with webhook processing.
 *
 * Usage:
 * node scripts/test-webhook.js
 */

const crypto = require("crypto");
const fetch = require("node-fetch");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3001";

if (!CLERK_WEBHOOK_SECRET) {
  console.error(
    "❌ ERROR: CLERK_WEBHOOK_SECRET is not set in your environment variables"
  );
  process.exit(1);
}

// Create a test user payload
const userId = `user_${crypto.randomBytes(10).toString("hex")}`;
const emailId = `email_${crypto.randomBytes(10).toString("hex")}`;
const testPayload = {
  data: {
    id: userId,
    email_addresses: [
      {
        id: emailId,
        email_address: `test-${crypto
          .randomBytes(4)
          .toString("hex")}@example.com`,
        verification: { status: "verified" },
      },
    ],
    primary_email_address_id: emailId,
    first_name: "Test",
    last_name: "User",
    object: "user",
  },
  type: "user.created",
  object: "event",
  timestamp: Date.now(),
};

// Convert payload to string
const payloadString = JSON.stringify(testPayload);

// Generate Svix headers
const messageId = crypto.randomBytes(16).toString("hex");
const timestamp = Math.floor(Date.now() / 1000).toString();
const toSign = `${timestamp}.${messageId}.${payloadString}`;
const signature = crypto
  .createHmac("sha256", CLERK_WEBHOOK_SECRET)
  .update(toSign)
  .digest("hex");

// Create headers
const headers = {
  "Content-Type": "application/json",
  "svix-id": messageId,
  "svix-timestamp": timestamp,
  "svix-signature": `v1,${signature}`,
};

console.log("\n🔍 Clerk Webhook Test Tool 🔍\n");
console.log(`Sending test webhook to: ${SERVER_URL}/webhooks/clerk`);
console.log(`User ID: ${userId}`);
console.log(`Email: ${testPayload.data.email_addresses[0].email_address}`);
console.log(`Timestamp: ${new Date(testPayload.timestamp).toISOString()}`);
console.log("\nHeaders:");
console.log(JSON.stringify(headers, null, 2));
console.log("\nPayload:");
console.log(JSON.stringify(testPayload, null, 2));

// Send the request
async function sendWebhook() {
  try {
    const response = await fetch(`${SERVER_URL}/webhooks/clerk`, {
      method: "POST",
      headers: headers,
      body: payloadString,
    });

    const responseData = await response.text();

    console.log("\nResponse:");
    console.log(`Status: ${response.status} ${response.statusText}`);

    try {
      // Try to parse as JSON
      const jsonData = JSON.parse(responseData);
      console.log(JSON.stringify(jsonData, null, 2));
    } catch (e) {
      // If not JSON, show as text
      console.log(responseData);
    }

    if (response.ok) {
      console.log("\n✅ Webhook test successful!");
      console.log("Check your database to see if the user was created.");
    } else {
      console.log("\n❌ Webhook test failed!");
      console.log("Check your server logs for more details.");
    }
  } catch (error) {
    console.error("\n❌ Error sending webhook:", error.message);
    console.log("Make sure your server is running and accessible.");
  }
}

sendWebhook();
