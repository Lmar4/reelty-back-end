import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const prisma = new PrismaClient();
const s3Client = new S3Client({ region: process.env.AWS_REGION });

async function cleanupS3Bucket(bucketName: string) {
  console.log(`Cleaning up S3 bucket: ${bucketName}...`);
  try {
    // List all objects in the bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
    });

    const listedObjects = await s3Client.send(listCommand);
    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      console.log(`✓ Bucket ${bucketName} is already empty`);
      return;
    }

    // Delete all objects
    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: listedObjects.Contents.map(({ Key }) => ({ Key })),
      },
    });

    await s3Client.send(deleteCommand);
    console.log(
      `✓ Deleted ${listedObjects.Contents.length} objects from ${bucketName}`
    );

    // If there might be more objects (truncated), recursively delete them
    if (listedObjects.IsTruncated) {
      await cleanupS3Bucket(bucketName);
    }
  } catch (error) {
    console.error(`Error cleaning S3 bucket ${bucketName}:`, error);
    throw error;
  }
}

async function cleanup() {
  console.log("Starting cleanup...");

  try {
    // Clean up S3 buckets first
    const buckets = [
      process.env.S3_BUCKET, // Main bucket
      process.env.VIDEOS_BUCKET_NAME, // Videos bucket if different
    ].filter(Boolean) as string[];

    console.log("Cleaning up S3 buckets...");
    for (const bucket of buckets) {
      await cleanupS3Bucket(bucket);
    }
    console.log("✓ S3 cleanup completed");

    // Delete all jobs first (due to foreign key constraints)
    console.log("Deleting video jobs...");
    await prisma.videoJob.deleteMany({});
    console.log("✓ All video jobs deleted");

    // Delete all photos
    console.log("Deleting photos...");
    await prisma.photo.deleteMany({});
    console.log("✓ All photos deleted");

    // Delete all listings
    console.log("Deleting listings...");
    await prisma.listing.deleteMany({});
    console.log("✓ All listings deleted");

    console.log("Cleanup completed successfully!");
  } catch (error) {
    console.error("Error during cleanup:", error);
  } finally {
    await prisma.$disconnect();
  }
}

cleanup();
