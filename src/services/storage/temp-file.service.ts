import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";

export interface TempFile {
  path: string;
  filename: string;
  cleanup: () => Promise<void>;
}

export class TempFileManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(os.tmpdir(), "reelty-processing");
  }

  public async initialize(): Promise<void> {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
  }

  public async createTempPath(
    originalFilename: string,
    subDir?: string
  ): Promise<TempFile> {
    const sessionId = uuidv4();
    const directory = subDir
      ? path.join(this.baseDir, sessionId, subDir)
      : path.join(this.baseDir, sessionId);

    await fs.promises.mkdir(directory, { recursive: true });

    // Clean the filename and remove any query parameters
    const cleanFilename = path.basename(originalFilename).split("?")[0];
    const tempPath = path.join(directory, cleanFilename);

    const cleanup = async () => {
      try {
        await fs.promises.rm(directory, { recursive: true, force: true });
      } catch (error) {
        console.error("Failed to cleanup temp directory:", {
          directory,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };

    return {
      path: tempPath,
      filename: cleanFilename,
      cleanup,
    };
  }

  public async writeFile(tempFile: TempFile, data: Buffer): Promise<void> {
    await fs.promises.writeFile(tempFile.path, data);
  }

  public async readFile(tempFile: TempFile): Promise<Buffer> {
    return fs.promises.readFile(tempFile.path);
  }

  public async exists(tempFile: TempFile): Promise<boolean> {
    try {
      await fs.promises.access(tempFile.path);
      return true;
    } catch {
      return false;
    }
  }

  public async cleanup(): Promise<void> {
    try {
      await fs.promises.rm(this.baseDir, { recursive: true, force: true });
      await this.initialize();
    } catch (error) {
      console.error("Failed to cleanup base directory:", {
        baseDir: this.baseDir,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

// Export singleton instance
export const tempFileManager = new TempFileManager(
  process.env.TEMP_OUTPUT_DIR || undefined
);
