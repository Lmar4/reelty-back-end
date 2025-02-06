import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ImageToVideoConverter } from "./imageToVideoConverter";
import { VisionProcessor } from "./visionProcessor";
import { MapCapture } from "./mapCapture";
import { TemplateKey } from "./templates/types";

const prisma = new PrismaClient();

export class ProductionPipeline {
  private videoConverter: ImageToVideoConverter;
  private visionProcessor: VisionProcessor;
  private mapCapture: MapCapture;

  constructor(runwayApiKey: string, outputDir: string = "./output") {
    this.videoConverter = new ImageToVideoConverter(runwayApiKey, outputDir);
    this.visionProcessor = new VisionProcessor();
    this.mapCapture = new MapCapture(`${outputDir}/maps`);
  }

  private async updateJobStatus(
    jobId: string,
    status: "processing" | "completed" | "error",
    error?: string
  ): Promise<void> {
    await prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status,
        ...(error && { error }),
      },
    });
  }

  private async downloadFromS3(s3Path: string): Promise<string> {
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const { bucket, key } = this.parseS3Path(s3Path);
    const localPath = path.join(os.tmpdir(), path.basename(key));

    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);

    if (response.Body) {
      const writeStream = fs.createWriteStream(localPath);
      await new Promise((resolve, reject) => {
        if (response.Body instanceof Readable) {
          response.Body.pipe(writeStream)
            .on("finish", resolve)
            .on("error", reject);
        }
      });
    }

    return localPath;
  }

  private async uploadToS3(
    localPath: string,
    destinationPath: string
  ): Promise<string> {
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const { bucket, key } = this.parseS3Path(destinationPath);

    const fileStream = fs.createReadStream(localPath);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: "image/webp",
    });

    await s3Client.send(command);
    return `s3://${bucket}/${key}`;
  }

  private parseS3Path(s3Path: string): { bucket: string; key: string } {
    const [, bucket, ...keyParts] = s3Path.replace("s3://", "").split("/");
    return { bucket, key: keyParts.join("/") };
  }

  private async cleanupFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to cleanup file ${filePath}:`, error);
    }
  }

  private async processImage(s3Path: string): Promise<string> {
    let originalPath: string | null = null;
    let webpPath: string | null = null;

    try {
      // Download original
      originalPath = await this.downloadFromS3(s3Path);

      // Convert to WebP
      webpPath = await this.visionProcessor.convertToWebP(
        originalPath,
        undefined,
        {
          quality: 80,
          width: 1080, // Match the video width
          height: 1920, // Match the video height
          fit: "cover",
        }
      );

      // Upload WebP version and replace original in S3
      const webpS3Path = s3Path.replace(/\.[^.]+$/, ".webp");
      await this.uploadToS3(webpPath, webpS3Path);

      return webpS3Path;
    } catch (error) {
      throw error;
    } finally {
      // Cleanup temporary files
      if (originalPath) await this.cleanupFile(originalPath);
      if (webpPath) await this.cleanupFile(webpPath);
    }
  }

  async runProductionPipeline(jobId: string): Promise<boolean> {
    try {
      // Get job details
      const job = await prisma.videoJob.findUnique({
        where: { id: jobId },
        include: {
          listing: true,
        },
      });

      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      await this.updateJobStatus(jobId, "processing");

      // Process each image to WebP and get S3 paths
      const webpS3Paths = await Promise.all(
        (job.inputFiles as string[]).map(async (s3Path) => {
          try {
            return await this.processImage(s3Path);
          } catch (error) {
            console.error(`Failed to process image ${s3Path}:`, error);
            throw new Error(
              `Failed to process image: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            );
          }
        })
      );

      // Process optimized images and map frames concurrently
      const [processedImages, mapFrames] = await Promise.all([
        Promise.all(
          webpS3Paths.map(async (s3Path: string) => {
            // We'll analyze the WebP version directly from S3
            const cropCoords = await this.visionProcessor.analyzeImageForCrop(
              s3Path
            );
            return s3Path; // Using S3 paths directly
          })
        ),
        this.mapCapture.captureMapAnimation(job.listing.address),
      ]);

      // Create video using template
      const templateKey = (job.template || "crescendo") as TemplateKey;
      const mapVideoPath = mapFrames.length > 0 ? mapFrames[0] : undefined;

      const videoPath = await this.videoConverter.createTemplate(
        templateKey,
        processedImages,
        mapVideoPath
      );

      // Update job with success
      await this.updateJobStatus(jobId, "completed");
      await prisma.videoJob.update({
        where: { id: jobId },
        data: { outputFile: videoPath },
      });

      return true;
    } catch (error) {
      // Update job with error
      await this.updateJobStatus(
        jobId,
        "error",
        error instanceof Error ? error.message : "Unknown error"
      );
      return false;
    }
  }
}
