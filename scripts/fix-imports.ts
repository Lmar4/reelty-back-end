import fs from "fs/promises";
import path from "path";
import { glob } from "glob";

const SRC_DIR = path.join(process.cwd(), "src");

// Regex to match different types of imports
const IMPORT_REGEX =
  /import\s+(?:(?:[\w\s{},*]+)\s+from\s+)?['"]([./][^'"]+)['"]/g;

async function processFile(filePath: string) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    let modified = content;
    let hasChanges = false;

    // Replace imports
    modified = content.replace(IMPORT_REGEX, (match, importPath) => {
      // Skip if already has .js extension or is a directory import ending with /index
      if (importPath.endsWith(".js") || importPath.endsWith("/index")) {
        return match;
      }

      // Skip if it's a directory import
      if (importPath.endsWith("/")) {
        return match;
      }

      // Skip non-relative imports (node_modules)
      if (!importPath.startsWith(".")) {
        return match;
      }

      hasChanges = true;
      const newImportPath = `${importPath}.js`;
      return match.replace(importPath, newImportPath);
    });

    if (hasChanges) {
      await fs.writeFile(filePath, modified, "utf-8");
      console.log(
        `✅ Updated imports in ${path.relative(process.cwd(), filePath)}`
      );
    }
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error);
  }
}

async function main() {
  try {
    // Find all TypeScript files in src and prisma directories
    const files = await glob("{src,prisma}/**/*.ts", {
      ignore: ["src/**/*.d.ts", "src/**/*.test.ts", "src/**/__tests__/**"],
      cwd: process.cwd(),
      absolute: true,
    });

    console.log(`Found ${files.length} TypeScript files to process`);

    // Process all files
    await Promise.all(files.map(processFile));

    console.log("\n✨ All files processed successfully!");
  } catch (error) {
    console.error("Failed to process files:", error);
    process.exit(1);
  }
}

main();
