#!/usr/bin/env node

/**
 * This script verifies that the Clerk webhook secret is correctly configured
 * and helps diagnose issues with webhook verification.
 *
 * Usage:
 * node scripts/verify-webhook-secret.js
 */

const fs = require("fs");
const path = require("path");
const { Webhook } = require("svix");
const crypto = require("crypto");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

console.log("\n🔍 Clerk Webhook Secret Verification Tool 🔍\n");

// Check if the webhook secret exists
if (!CLERK_WEBHOOK_SECRET) {
  console.error(
    "❌ ERROR: CLERK_WEBHOOK_SECRET is not set in your environment variables"
  );
  console.log(
    "Please set this variable in your .env file or in your deployment environment"
  );
  process.exit(1);
}

console.log(
  `✅ CLERK_WEBHOOK_SECRET is set (${CLERK_WEBHOOK_SECRET.substring(0, 5)}...)`
);
console.log(`   Length: ${CLERK_WEBHOOK_SECRET.length} characters`);

// Check if the secret has the correct format (should start with whsec_)
if (!CLERK_WEBHOOK_SECRET.startsWith("whsec_")) {
  console.warn('⚠️  WARNING: Your webhook secret does not start with "whsec_"');
  console.log(
    '   This might be incorrect. Clerk webhook secrets typically start with "whsec_"'
  );
}

// Create a test webhook instance
try {
  const webhook = new Webhook(CLERK_WEBHOOK_SECRET);
  console.log("✅ Successfully created Webhook instance with the secret");
} catch (error) {
  console.error("❌ ERROR: Failed to create Webhook instance:", error.message);
  process.exit(1);
}

// Generate a test payload and signature for verification
const testPayload = JSON.stringify({
  data: { id: "test_user_id", object: "user" },
  type: "user.created",
  timestamp: Date.now(),
});

console.log("\n📋 Testing webhook signature verification with sample payload:");
console.log(`   Payload length: ${testPayload.length} characters`);

// Generate a timestamp and message ID
const timestamp = Math.floor(Date.now() / 1000).toString();
const messageId = crypto.randomBytes(16).toString("hex");

try {
  // Create a signature manually for testing
  const toSign = `${timestamp}.${messageId}.${testPayload}`;
  const signature = crypto
    .createHmac("sha256", CLERK_WEBHOOK_SECRET)
    .update(toSign)
    .digest("hex");

  console.log("✅ Successfully generated test signature");

  // Now verify using the Svix library
  const webhook = new Webhook(CLERK_WEBHOOK_SECRET);

  const headers = {
    "svix-id": messageId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };

  try {
    const result = webhook.verify(testPayload, headers);
    console.log(
      "✅ Successfully verified test payload with generated signature"
    );
    console.log(
      "   This confirms your webhook secret is valid and working correctly"
    );
  } catch (verifyError) {
    console.error(
      "❌ ERROR: Failed to verify test payload:",
      verifyError.message
    );
    console.log(
      "   This indicates an issue with the webhook verification process"
    );
  }
} catch (error) {
  console.error("❌ ERROR: Failed to generate test signature:", error.message);
}

console.log("\n📝 Recommendations:");
console.log(
  "1. Ensure the CLERK_WEBHOOK_SECRET in your production environment"
);
console.log(
  "   matches exactly with the webhook secret in your Clerk dashboard"
);
console.log("2. Check that your webhook URL in Clerk dashboard is correct");
console.log(
  "3. Verify that your server is correctly parsing the raw request body"
);
console.log(
  "4. Check for any proxy or load balancer that might modify the request"
);

console.log("\n🔗 Clerk Documentation:");
console.log("   https://clerk.com/docs/integration/webhooks");
console.log("\n");
