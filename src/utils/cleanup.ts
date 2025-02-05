import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { createLogger, format, transports } from 'winston';

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  defaultMeta: { service: 'file-cleanup' },
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/cleanup.log' })
  ]
});

export interface CleanupConfig {
  directories: string[];
  maxAgeHours: number;
  dryRun?: boolean;
}

export async function cleanupTemporaryFiles(config: CleanupConfig): Promise<void> {
  const now = Date.now();
  const maxAgeMs = config.maxAgeHours * 60 * 60 * 1000;

  for (const dir of config.directories) {
    try {
      logger.info(`Starting cleanup of directory: ${dir}`);
      
      const files = await readdir(dir);
      let deletedCount = 0;
      let totalSize = 0;

      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await stat(filePath);

        if (!stats.isFile()) continue;

        const fileAge = now - stats.mtimeMs;
        if (fileAge > maxAgeMs) {
          if (!config.dryRun) {
            await unlink(filePath);
          }
          deletedCount++;
          totalSize += stats.size;
          
          logger.info('Deleted file', {
            file: filePath,
            age: Math.round(fileAge / (60 * 60 * 1000)),
            size: Math.round(stats.size / 1024),
            dryRun: config.dryRun
          });
        }
      }

      logger.info('Cleanup completed', {
        directory: dir,
        deletedFiles: deletedCount,
        totalSizeMB: Math.round(totalSize / (1024 * 1024)),
        dryRun: config.dryRun
      });

    } catch (error) {
      logger.error('Error during cleanup', {
        directory: dir,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

// Example usage:
// await cleanupTemporaryFiles({
//   directories: [
//     path.join(process.cwd(), 'uploads'),
//     path.join(process.cwd(), 'tmp')
//   ],
//   maxAgeHours: 24,
//   dryRun: false
// });
