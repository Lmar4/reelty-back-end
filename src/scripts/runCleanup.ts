import { cleanupTemporaryFiles } from "../utils/cleanup";
import * as path from "path";

const tempDir = path.join(process.cwd(), "temp");
const uploadsDir = path.join(process.cwd(), "uploads");
const logsDir = path.join(process.cwd(), "logs");

// Ensure directories exist
[tempDir, uploadsDir, logsDir].forEach((dir) => {
  if (!require("fs").existsSync(dir)) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
});

async function runCleanup() {
  try {
    await cleanupTemporaryFiles({
      directories: [tempDir, uploadsDir, logsDir],
      maxAgeHours: 24,
      dryRun: false,
    });
  } catch (error) {
    console.error("Cleanup failed:", error);
    process.exit(1);
  }
}

runCleanup();
