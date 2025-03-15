import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import * as fs from "fs/promises";
import { logger } from "../../utils/logger.js";
import { s3Service } from "../storage/s3.service.js";

interface AssetMetadata {
  deletionStarted?: string;
  lastCleanupAttempt?: string;
  lastCleanupError?: string;
  [key: string]: any;
}

export class CleanupService {
  private static instance: CleanupService;
  private prisma: PrismaClient;
  private s3Client: S3Client;
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly LISTING_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.prisma = new PrismaClient();
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  public static getInstance(): CleanupService {
    if (!CleanupService.instance) {
      CleanupService.instance = new CleanupService();
    }
    return CleanupService.instance;
  }

  public async initialize(): Promise<void> {
    this.cleanupInterval = setInterval(
      () => this.cleanupOldListings(),
      this.CLEANUP_INTERVAL
    );
    await this.cleanupOldListings();
  }

  public async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private async verifyS3Deletion(s3Key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.AWS_BUCKET || "reelty-prod-storage",
          Key: s3Key,
        })
      );
      // If HeadObject succeeds, file still exists
      return false;
    } catch (error) {
      // If error is 404, file is deleted
      if (
        error instanceof Error &&
        "name" in error &&
        error.name === "NotFound"
      ) {
        return true;
      }
      throw error;
    }
  }

  private async cleanupOldListings(): Promise<void> {
    try {
      logger.info("Starting cleanup of old listing outputs");

      const oldJobs = await this.prisma.videoJob.findMany({
        where: {
          status: VideoGenerationStatus.COMPLETED,
          createdAt: {
            lt: new Date(Date.now() - this.LISTING_TTL),
          },
          outputFile: {
            not: null,
          },
        },
        select: {
          id: true,
          outputFile: true,
          listingId: true,
        },
      });

      logger.info(`Found ${oldJobs.length} old video jobs to clean up`);

      for (const job of oldJobs) {
        await this.prisma.$transaction(async (tx) => {
          try {
            if (!job.outputFile) {
              throw new Error(`Job ${job.id} has no output file`);
            }

            // Delete from S3 if it's an S3 path
            if (
              job.outputFile.startsWith("s3://") ||
              job.outputFile.includes("amazonaws.com")
            ) {
              const s3Key = s3Service.getKeyFromUrl(job.outputFile);
              if (s3Key) {
                await s3Service.deleteFile(s3Key);
                // Verify deletion
                const isDeleted = await this.verifyS3Deletion(s3Key);
                if (!isDeleted) {
                  throw new Error(
                    `Failed to verify S3 deletion for key: ${s3Key}`
                  );
                }
                logger.info(`Verified S3 file deletion: ${s3Key}`);
              }
            }
            // Delete local file if it exists
            else {
              try {
                await fs.access(job.outputFile);
                await fs.unlink(job.outputFile);
                // Verify local deletion
                try {
                  await fs.access(job.outputFile);
                  throw new Error(
                    `Failed to delete local file: ${job.outputFile}`
                  );
                } catch (error) {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code !== "ENOENT"
                  ) {
                    throw error;
                  }
                }
                logger.info(`Verified local file deletion: ${job.outputFile}`);
              } catch (error) {
                if (
                  error instanceof Error &&
                  "code" in error &&
                  error.code !== "ENOENT"
                ) {
                  throw error;
                }
              }
            }

            // Update the job to mark output as cleaned
            await tx.videoJob.update({
              where: { id: job.id },
              data: {
                metadata: {
                  cleanedUp: true,
                  cleanupTime: new Date().toISOString(),
                },
              },
            });

            logger.info(`Successfully cleaned up job ${job.id}`);
          } catch (error) {
            logger.error(`Failed to cleanup job ${job.id}:`, error);
            throw error; // Propagate error to trigger transaction rollback
          }
        });
      }

      await this.cleanupProcessedAssets();
    } catch (error) {
      logger.error("Error during listing cleanup:", error);
      throw error; // Propagate error for monitoring/alerting
    }
  }

  private async cleanupProcessedAssets(): Promise<void> {
    try {
      const oldAssets = await this.prisma.processedAsset.findMany({
        where: {
          createdAt: {
            lt: new Date(Date.now() - this.LISTING_TTL),
          },
        },
      });

      for (const asset of oldAssets) {
        await this.prisma.$transaction(
          async (tx) => {
            try {
              const currentMetadata = (asset.metadata || {}) as AssetMetadata;

              // First mark the asset as being deleted
              await tx.processedAsset.update({
                where: { id: asset.id },
                data: {
                  metadata: {
                    ...currentMetadata,
                    deletionStarted: new Date().toISOString(),
                  },
                },
              });

              // Delete the actual file
              if (
                asset.path.startsWith("s3://") ||
                asset.path.includes("amazonaws.com")
              ) {
                const s3Key = s3Service.getKeyFromUrl(asset.path);
                if (s3Key) {
                  // First verify the file exists
                  const exists = await this.verifyS3Deletion(s3Key);
                  if (!exists) {
                    logger.info("S3 file already deleted", {
                      assetId: asset.id,
                      s3Key,
                    });
                  } else {
                    // File exists, delete it
                    await s3Service.deleteFile(s3Key);
                    // Verify deletion
                    const isDeleted = await this.verifyS3Deletion(s3Key);
                    if (!isDeleted) {
                      throw new Error(
                        `Failed to verify S3 deletion for key: ${s3Key}`
                      );
                    }
                  }
                }
              } else {
                try {
                  await fs.access(asset.path);
                  await fs.unlink(asset.path);
                  // Verify local deletion
                  try {
                    await fs.access(asset.path);
                    throw new Error(
                      `Failed to delete local file: ${asset.path}`
                    );
                  } catch (error) {
                    if (
                      error instanceof Error &&
                      "code" in error &&
                      error.code !== "ENOENT"
                    ) {
                      throw error;
                    }
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code !== "ENOENT"
                  ) {
                    throw error;
                  }
                }
              }

              // Finally delete the database record
              await tx.processedAsset.delete({
                where: { id: asset.id },
              });

              logger.info(
                `Successfully cleaned up processed asset ${asset.id}`
              );
            } catch (error) {
              const currentMetadata = (asset.metadata || {}) as AssetMetadata;

              // If anything fails, update the asset with error information
              await tx.processedAsset.update({
                where: { id: asset.id },
                data: {
                  metadata: {
                    ...currentMetadata,
                    lastCleanupAttempt: new Date().toISOString(),
                    lastCleanupError:
                      error instanceof Error ? error.message : "Unknown error",
                  },
                },
              });

              logger.error(
                `Failed to cleanup processed asset ${asset.id}:`,
                error
              );
              throw error; // Propagate error to trigger transaction rollback
            }
          },
          {
            maxWait: 5000, // 5 seconds max wait
            timeout: 30000, // 30 seconds timeout
          }
        );
      }
    } catch (error) {
      logger.error("Error during processed assets cleanup:", error);
      throw error; // Propagate error for monitoring/alerting
    }
  }
}

export const cleanupService = CleanupService.getInstance();
