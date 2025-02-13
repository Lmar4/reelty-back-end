import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import { RunwayClient } from "../runway";
import { runwayService } from "../video/runway.service";
import { s3VideoService } from "../video/s3-video.service";
import { videoProcessingService } from "../video/video-processing.service";
import { videoTemplateService } from "../video/video-template.service";
import { imageProcessor } from "./image.service";
import { TemplateKey } from "./templates/types";
import { AssetCacheService } from "../cache/assetCache";

const prisma = new PrismaClient();

// Add ProcessedImage type
export interface ProcessedImage {
  croppedPath: string;
  s3WebpPath: string;
  uploadPromise: Promise<any>;
  // Add other properties if needed
}

export interface VideoClip {
  path: string;
  duration: number;
}

export interface VideoTemplate {
  duration: 5 | 10; // Only 5 or 10 seconds allowed
  ratio?: "1280:768" | "768:1280"; // Only these aspect ratios allowed
  watermark?: boolean; // Optional watermark flag
  headers?: {
    [key: string]: string;
  };
}

export class ImageToVideoConverter {
  private static instance: ImageToVideoConverter;
  private runwayClient: RunwayClient;
  private outputDir: string;
  private videoFiles: string[] | null = null;
  private mapFrames: string[] | null = null;
  private apiKey: string;
  private assetCache: AssetCacheService;

  private constructor(apiKey: string, outputDir: string = "./output") {
    if (!apiKey) {
      throw new Error("RunwayML API key is required");
    }
    this.runwayClient = new RunwayClient(apiKey);
    this.outputDir = outputDir;
    this.apiKey = apiKey;
    this.assetCache = AssetCacheService.getInstance();
  }

  public static getInstance(
    apiKey: string = process.env.RUNWAYML_API_KEY || ""
  ): ImageToVideoConverter {
    if (!ImageToVideoConverter.instance) {
      ImageToVideoConverter.instance = new ImageToVideoConverter(apiKey);
    }
    return ImageToVideoConverter.instance;
  }

  private async ensureDirectoryExists(dir: string): Promise<void> {
    if (
      !(await fs.promises
        .access(dir)
        .then(() => true)
        .catch(() => false))
    ) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  public parseS3Path(s3Path: string): { bucket: string; key: string } {
    // Handle s3:// protocol
    if (s3Path.startsWith("s3://")) {
      const [, , bucket, ...keyParts] = s3Path.split("/");
      return { bucket, key: keyParts.join("/") };
    }

    // Handle https:// protocol
    const url = new URL(s3Path);
    const bucket = url.hostname.split(".")[0];
    const key = decodeURIComponent(url.pathname.substring(1)); // Remove leading slash
    return { bucket, key: key.split("?")[0] }; // Remove query parameters
  }

  public async uploadToS3(localPath: string, s3Path: string): Promise<void> {
    const { bucket, key } = this.parseS3Path(s3Path);
    const fileContent = await fs.promises.readFile(localPath);

    const s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileContent,
      ContentType: "image/webp",
    });

    await s3Client.send(command);
  }

  private async generateRunwayVideo(
    imageUrl: string,
    index: number
  ): Promise<string> {
    try {
      // Ensure we have a public HTTPS URL for the image
      let publicUrl = imageUrl;

      // If it's an s3:// URL, convert it to a public HTTPS URL
      if (imageUrl.startsWith("s3://")) {
        const { bucket, key } = s3VideoService.parseS3Path(imageUrl);
        publicUrl = s3VideoService.getPublicUrl(bucket, key);
      }

      // If it's not an HTTPS URL, construct it from the path
      if (!publicUrl.startsWith("https://")) {
        publicUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${publicUrl}`;
      }

      console.log("Sending request to Runway with image URL:", publicUrl);
      return await runwayService.generateVideo(publicUrl, index);
    } catch (error) {
      throw new Error(
        `Failed to generate video: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private async getCachedVideo(
    imageUrl: string,
    index: number
  ): Promise<string | null> {
    const cachedAsset = await this.assetCache.getCachedAsset(
      this.assetCache.generateCacheKey("video", { index })
    );
    return cachedAsset?.path || null;
  }

  private async cacheVideo(
    imageUrl: string,
    videoPath: string,
    index: number
  ): Promise<void> {
    await this.assetCache.cacheAsset({
      type: "video",
      path: videoPath,
      cacheKey: this.assetCache.generateCacheKey("video", { index }),
      metadata: {
        timestamp: new Date(),
        settings: { index },
        hash: "",
      },
    });
  }

  async regenerateVideos(photoIds: string[]): Promise<string[]> {
    const photos = await prisma.photo.findMany({
      where: {
        id: { in: photoIds },
        processedFilePath: { not: null },
      },
    });

    if (photos.length === 0) {
      throw new Error("No valid photos found for regeneration");
    }

    const regeneratedVideos: string[] = [];

    for (const photo of photos) {
      try {
        // Update photo status
        await prisma.photo.update({
          where: { id: photo.id },
          data: { status: "processing", error: null },
        });

        // Get the S3 path for the processed WebP image
        const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${photo.processedFilePath}`;

        // Check cache first
        const cachedVideo = await this.getCachedVideo(
          s3WebpPath,
          parseInt(photo.id)
        );
        if (cachedVideo) {
          console.log("Cache hit for video:", {
            photoId: photo.id,
            cachedVideo,
          });
          regeneratedVideos.push(cachedVideo);
          continue;
        }

        // Process the image using imageProcessor service
        const processedImage = await imageProcessor.processImage(s3WebpPath);

        // Wait for any WebP processing to complete
        await processedImage.uploadPromise;

        // Get the proper S3 URL from the processed image path
        const { bucket, key } = s3VideoService.parseS3Path(
          processedImage.s3WebpPath
        );
        const publicUrl = s3VideoService.getPublicUrl(bucket, key);

        console.log("Using public URL for Runway:", publicUrl);

        // Generate new video using the public URL
        const videoPath = await this.generateRunwayVideo(
          publicUrl,
          parseInt(photo.id)
        );

        // Cache the video
        await this.cacheVideo(s3WebpPath, videoPath, parseInt(photo.id));

        // Store the individual video path
        await prisma.photo.update({
          where: { id: photo.id },
          data: {
            runwayVideoPath: videoPath,
            status: "completed",
          },
        });

        regeneratedVideos.push(videoPath);
      } catch (error) {
        // Update photo with error status
        await prisma.photo.update({
          where: { id: photo.id },
          data: {
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Unknown error during regeneration",
          },
        });
        console.error(
          `Failed to regenerate video for photo ${photo.id}:`,
          error
        );
      }
    }

    return regeneratedVideos;
  }

  async convertImagesToVideo(
    inputFiles: string[],
    template: VideoTemplate
  ): Promise<string> {
    try {
      const outputDir = this.outputDir;
      await this.ensureDirectoryExists(outputDir);

      const outputFile = path.join(
        outputDir,
        `${Date.now()}-${path.basename(inputFiles[0])}.mp4`
      );

      // Check cache first
      const cachedVideo = await this.getCachedVideo(inputFiles[0], 0);
      if (cachedVideo) {
        console.log("Cache hit for video:", {
          input: inputFiles[0],
          cachedVideo,
        });
        return cachedVideo;
      }

      // Process the first image using imageProcessor service
      const processedImage = await imageProcessor.processImage(inputFiles[0]);

      // Wait for the WebP upload to complete
      await processedImage.uploadPromise;

      // Get the proper S3 URL from the processed image path
      const { bucket, key } = s3VideoService.parseS3Path(
        processedImage.s3WebpPath
      );
      const publicUrl = s3VideoService.getPublicUrl(bucket, key);

      console.log("Using public URL for Runway:", publicUrl);

      // Generate video using the public URL
      const videoPath = await this.generateRunwayVideo(publicUrl, 0);

      // Cache the video
      await this.cacheVideo(inputFiles[0], videoPath, 0);

      console.log("Video created successfully:", videoPath);
      return videoPath;
    } catch (error) {
      throw new Error(
        `Failed to convert images to video: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  async setMapFrames(mapFramesDir: string): Promise<void> {
    const files = await fs.promises.readdir(mapFramesDir);
    this.mapFrames = files
      .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
      .sort()
      .map((f) => path.join(mapFramesDir, f));
  }

  async createTemplate(
    templateKey: TemplateKey,
    inputVideos: string[],
    mapVideoPath?: string
  ): Promise<string> {
    const outputPath = path.join(
      this.outputDir,
      `${templateKey}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}.mp4`
    );

    // Get clips configuration from template service
    const clips = await videoTemplateService.createTemplate(
      templateKey,
      inputVideos,
      mapVideoPath
    );

    // Use video processing service to stitch videos
    await videoProcessingService.stitchVideos(
      clips.map((clip) => clip.path),
      clips.map((clip) => clip.duration),
      outputPath
    );

    console.log(`${templateKey} video created at: ${outputPath}`);
    return outputPath;
  }
}

// Export singleton instance
export const imageToVideoConverter = ImageToVideoConverter.getInstance();
