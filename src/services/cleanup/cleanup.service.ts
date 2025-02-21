import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { logger } from "../../utils/logger";
import { s3Service } from "../storage/s3.service";
import * as fs from "fs/promises";
import * as path from "path";

export class CleanupService {
  private static instance: CleanupService;
  private prisma: PrismaClient;
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly LISTING_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): CleanupService {
    if (!CleanupService.instance) {
      CleanupService.instance = new CleanupService();
    }
    return CleanupService.instance;
  }

  public async initialize(): Promise<void> {
    // Start the cleanup interval
    this.cleanupInterval = setInterval(
      () => this.cleanupOldListings(),
      this.CLEANUP_INTERVAL
    );

    // Run initial cleanup
    await this.cleanupOldListings();
  }

  public async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private async cleanupOldListings(): Promise<void> {
    try {
      logger.info("Starting cleanup of old listing outputs");

      // Find completed video jobs older than 24 hours
      const oldJobs = await this.prisma.videoJob.findMany({
        where: {
          status: VideoGenerationStatus.COMPLETED,
          createdAt: {
            lt: new Date(Date.now() - this.LISTING_TTL)
          },
          outputFile: {
            not: null
          }
        },
        select: {
          id: true,
          outputFile: true,
          listingId: true
        }
      });

      logger.info(`Found ${oldJobs.length} old video jobs to clean up`);

      for (const job of oldJobs) {
        try {
          // Delete from S3 if it's an S3 path
          if (job.outputFile?.startsWith('s3://') || job.outputFile?.includes('amazonaws.com')) {
            const s3Key = s3Service.getKeyFromUrl(job.outputFile);
            if (s3Key) {
              await s3Service.deleteFile(s3Key);
              logger.info(`Deleted S3 file: ${s3Key}`);
            }
          }
          // Delete local file if it exists
          else if (job.outputFile) {
            try {
              await fs.access(job.outputFile);
              await fs.unlink(job.outputFile);
              logger.info(`Deleted local file: ${job.outputFile}`);
            } catch (error) {
              // File doesn't exist, which is fine
              if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
                logger.warn(`Error deleting local file: ${job.outputFile}`, error);
              }
            }
          }

          // Update the job to mark output as cleaned
          await this.prisma.videoJob.update({
            where: { id: job.id },
            data: {
              metadata: {
                cleanedUp: true,
                cleanupTime: new Date().toISOString()
              }
            }
          });

        } catch (error) {
          logger.error(`Failed to cleanup job ${job.id}:`, error);
        }
      }

      // Also clean up any orphaned processed assets
      await this.cleanupProcessedAssets();

    } catch (error) {
      logger.error("Error during listing cleanup:", error);
    }
  }

  private async cleanupProcessedAssets(): Promise<void> {
    try {
      // Find old processed assets
      const oldAssets = await this.prisma.processedAsset.findMany({
        where: {
          createdAt: {
            lt: new Date(Date.now() - this.LISTING_TTL)
          }
        }
      });

      for (const asset of oldAssets) {
        try {
          // Delete the actual file
          if (asset.path.startsWith('s3://') || asset.path.includes('amazonaws.com')) {
            const s3Key = s3Service.getKeyFromUrl(asset.path);
            if (s3Key) {
              await s3Service.deleteFile(s3Key);
            }
          } else {
            try {
              await fs.access(asset.path);
              await fs.unlink(asset.path);
            } catch (error) {
              // Ignore ENOENT errors
              if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
                throw error;
              }
            }
          }

          // Delete the database record
          await this.prisma.processedAsset.delete({
            where: { id: asset.id }
          });

        } catch (error) {
          logger.error(`Failed to cleanup processed asset ${asset.id}:`, error);
        }
      }
    } catch (error) {
      logger.error("Error during processed assets cleanup:", error);
    }
  }
}

export const cleanupService = CleanupService.getInstance();
