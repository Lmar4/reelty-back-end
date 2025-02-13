// Mock environment variables
process.env.AWS_REGION = "us-east-2";
process.env.AWS_ACCESS_KEY_ID = "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
process.env.AWS_BUCKET = "test-bucket";
process.env.TEMP_OUTPUT_DIR = "/tmp/reelty-test";

// Global test setup
beforeAll(async () => {
  // Add any global setup here
});

// Global test teardown
afterAll(async () => {
  // Add any global cleanup here
});
