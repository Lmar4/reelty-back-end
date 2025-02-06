import { PrismaClient } from "@prisma/client";
import { ImageToVideoConverter } from "./imageToVideoConverter";
import { VisionProcessor } from "./visionProcessor";
import { MapCapture } from "./mapCapture";

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

      // First convert images to WebP format
      const optimizedImages = await this.visionProcessor.batchConvertToWebP(
        job.inputFiles as string[],
        {
          quality: 80,
          width: 1080, // Match the video width
          height: 1920, // Match the video height
          fit: "cover",
        }
      );

      // Process optimized images concurrently
      const [processedImages, mapFrames] = await Promise.all([
        Promise.all(
          optimizedImages.map(async (imagePath: string) => {
            const cropCoords = await this.visionProcessor.analyzeImageForCrop(
              imagePath
            );
            // Apply cropping and return processed image path
            return imagePath; // TODO: Apply actual cropping
          })
        ),
        this.mapCapture.captureMapAnimation(job.listing.address),
      ]);

      // Combine all frames and convert to video
      const allFrames = [...processedImages, ...mapFrames];
      const videoPath = await this.videoConverter.convertImagesToVideo(
        allFrames,
        { duration: 3 }
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
