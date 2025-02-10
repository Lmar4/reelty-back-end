import { S3Client } from "@aws-sdk/client-s3";

// Validate required environment variables
const requiredEnvVars = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "",
  AWS_BUCKET: process.env.AWS_BUCKET || process.env.S3_BUCKET || "",
  AWS_REGION: process.env.AWS_REGION || "",
} as const;

// Check for missing environment variables
const missingVars = Object.entries(requiredEnvVars)
  .filter(([_, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(", ")}`
  );
}

// Simple S3 client configuration
export const s3Client = new S3Client({
  region: requiredEnvVars.AWS_REGION,
  credentials: {
    accessKeyId: requiredEnvVars.AWS_ACCESS_KEY_ID,
    secretAccessKey: requiredEnvVars.AWS_SECRET_ACCESS_KEY,
  },
});

// Basic config export
export const AWS_CONFIG = {
  bucket: requiredEnvVars.AWS_BUCKET,
  region: requiredEnvVars.AWS_REGION,
  credentials: {
    accessKeyId: requiredEnvVars.AWS_ACCESS_KEY_ID,
    secretAccessKey: requiredEnvVars.AWS_SECRET_ACCESS_KEY,
  },
} as const;

// Export bucket name for use in other modules
export const STORAGE_BUCKET_NAME = AWS_CONFIG.bucket;
