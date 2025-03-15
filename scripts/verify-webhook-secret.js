#!/usr/bin/env node

/**
 * This script verifies the webhook secret by checking if it's set in the environment
 * and printing its first and last few characters for verification.
 *
 * Usage:
 * node scripts/verify-webhook-secret.js
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";
import path from "path";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../.env") });

console.log("\n🔍 Clerk Webhook Secret Verification Tool 🔍\n");

const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

if (!CLERK_WEBHOOK_SECRET) {
  console.error(
    "❌ ERROR: CLERK_WEBHOOK_SECRET is not set in your environment variables"
  );
  console.error("Please set it in your .env file or environment variables");
  process.exit(1);
}

console.log(`✅ CLERK_WEBHOOK_SECRET is set`);
console.log(`Secret starts with: ${CLERK_WEBHOOK_SECRET.substring(0, 5)}...`);
console.log(
  `Secret ends with: ...${CLERK_WEBHOOK_SECRET.substring(
    CLERK_WEBHOOK_SECRET.length - 5
  )}`
);
console.log(`Secret length: ${CLERK_WEBHOOK_SECRET.length} characters`);

console.log("\n📝 Recommendations:");
console.log(
  "1. Verify that this secret matches the one in your Clerk dashboard"
);
console.log(
  "2. Make sure the webhook URL in Clerk dashboard is: https://reelty-backend-production.up.railway.app/webhooks/clerk"
);
console.log(
  "3. Ensure the webhook is active and subscribed to the user.created event"
);
