import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import ffmpeg from "fluent-ffmpeg";
import { RunwayClient } from "../runway";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ReelTemplate, TemplateKey, reelTemplates } from "./templates/types";
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();

// Add ProcessedImage type
export interface ProcessedImage {
  croppedPath: string;
  // Add other properties if needed
}

interface VideoClip {
  path: string;
  duration: number;
}

const exists = promisify(fs.exists);
const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const copyFile = promisify(fs.copyFile);

export interface VideoTemplate {
  duration: 5 | 10; // Only 5 or 10 seconds allowed
  ratio?: "1280:768" | "768:1280"; // Only these aspect ratios allowed
  watermark?: boolean; // Optional watermark flag
  headers?: {
    [key: string]: string;
  };
}

export class ImageToVideoConverter {
  private runwayClient: RunwayClient;
  private outputDir: string;
  private videoFiles: string[] | null = null;
  private mapFrames: string[] | null = null;
  private apiKey: string;

  constructor(apiKey: string, outputDir: string = "./output") {
    if (!apiKey) {
      throw new Error("RunwayML API key is required");
    }
    this.runwayClient = new RunwayClient(apiKey);
    this.outputDir = outputDir;
    this.apiKey = apiKey;
  }

  private async ensureDirectoryExists(dir: string): Promise<void> {
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async validateImagePaths(images: string[]): Promise<void> {
    for (const image of images) {
      if (!(await exists(image))) {
        throw new Error(`Image not found: ${image}`);
      }
    }
  }

  private async generateVideoSegment(
    filename: string,
    index: number
  ): Promise<string> {
    const maxRetries = 3;
    let retryCount = 0;

    // Validate environment variables
    if (!process.env.AWS_REGION) {
      throw new Error("AWS_REGION environment variable is not set");
    }

    while (retryCount < maxRetries) {
      try {
        // Find the WebP version directly from the database
        const photo = await prisma.photo.findFirst({
          where: {
            filePath: {
              contains: filename,
            },
            processedFilePath: { not: null },
          },
          include: {
            listing: true,
          },
        });

        if (!photo?.processedFilePath || !photo.listing) {
          throw new Error(
            `WebP version not found for image: ${filename}. Please ensure images are processed before regeneration.`
          );
        }

        // Use existing WebP file URL directly
        const imageUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${photo.processedFilePath}`;
        console.log("Using existing WebP URL:", imageUrl);

        // Create the video generation task
        const response = await this.runwayClient.imageToVideo({
          model: "gen3a_turbo",
          promptImage: imageUrl,
          promptText: "Move forward slowly",
          duration: 5,
          ratio: "768:1280",
        });

        // Poll for task completion
        let task = await this.runwayClient.tasks.retrieve(response.id);
        while (task.status === "PENDING" || task.status === "PROCESSING") {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          task = await this.runwayClient.tasks.retrieve(response.id);

          if (task.status === "FAILED") {
            throw new Error(task.failure || "Video generation failed");
          }

          if (
            task.status === "SUCCEEDED" &&
            task.output &&
            task.output.length > 0
          ) {
            // Download and save the video
            const videoResponse = await fetch(task.output[0]);
            if (!videoResponse.ok) {
              throw new Error(
                `Failed to download video: ${videoResponse.statusText}`
              );
            }

            const segmentPath = path.join(
              this.outputDir,
              `segment_${index}.mp4`
            );
            const videoBuffer = await videoResponse.arrayBuffer();
            await fs.promises.writeFile(segmentPath, Buffer.from(videoBuffer));
            console.log("Successfully downloaded and saved video");
            return segmentPath;
          }
        }

        throw new Error("Video generation timed out");
      } catch (error) {
        retryCount++;
        console.error("Failed to generate video segment:", {
          error: error instanceof Error ? error.message : "Unknown error",
          filename,
          index,
          attempt: retryCount,
          maxRetries,
        });

        if (retryCount === maxRetries) {
          throw new Error(
            `Failed to generate video segment for image ${index} after ${maxRetries} attempts: ${
              error instanceof Error
                ? error.message
                : "Failed to generate video"
            }`
          );
        }

        // Wait before retrying (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retryCount) * 1000)
        );
      }
    }

    throw new Error("Video generation failed after all retries");
  }

  private stitchVideoSegments(
    segments: string[],
    template: VideoTemplate
  ): Promise<string> {
    const outputPath = path.join(this.outputDir, `final_${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
      let command = ffmpeg();

      segments.forEach((segment) => {
        command = command.input(segment);
      });

      command
        .on("end", () => resolve(outputPath))
        .on("error", (err: Error) =>
          reject(new Error(`FFmpeg error: ${err.message}`))
        )
        .complexFilter([
          {
            filter: "concat",
            options: {
              n: segments.length,
              v: 1,
              a: 0,
            },
          },
        ])
        .output(outputPath)
        .run();
    });
  }

  async convertImagesToVideo(
    inputFiles: string[],
    template: VideoTemplate
  ): Promise<string> {
    try {
      const outputDir = this.outputDir;
      const outputFile = path.join(
        outputDir,
        `${Date.now()}-${path.basename(inputFiles[0])}.mp4`
      );

      // First try to find the WebP version in the database
      const originalKey = inputFiles[0];
      const photo = await prisma.photo.findFirst({
        where: {
          filePath: {
            contains: originalKey,
          },
          processedFilePath: { not: null },
        },
      });

      let promptImage: string;

      if (photo?.processedFilePath) {
        // Use existing WebP URL from the database
        promptImage = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${photo.processedFilePath}`;
        console.log("Using existing WebP URL:", promptImage);
      } else {
        // Process new image
        const imageBuffer = await fs.promises.readFile(inputFiles[0]);

        // Check file size (max 16MB unencoded, ~5MB encoded)
        const fileSizeInMB = imageBuffer.length / (1024 * 1024);
        if (fileSizeInMB > 3.3) {
          throw new Error(
            `Image file size (${fileSizeInMB.toFixed(
              2
            )}MB) exceeds Runway's limit of 3.3MB`
          );
        }

        // Validate and process image using sharp
        const imageInfo = await sharp(imageBuffer).metadata();

        // Check image dimensions
        if ((imageInfo.width || 0) > 8000 || (imageInfo.height || 0) > 8000) {
          throw new Error(
            `Image dimensions (${imageInfo.width}x${imageInfo.height}) exceed Runway's limit of 8000px`
          );
        }

        // Convert to WebP and upload to S3
        const processedBuffer = await sharp(imageBuffer)
          .resize(1080, 1920, {
            fit: "cover",
            position: "center",
          })
          .webp({ quality: 90 })
          .toBuffer();

        // Upload to S3
        const s3Client = new S3Client({ region: process.env.AWS_REGION });
        const tempKey = `temp/runway-inputs/${Date.now()}-${path.basename(
          inputFiles[0],
          path.extname(inputFiles[0])
        )}.webp`;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET,
            Key: tempKey,
            Body: processedBuffer,
            ContentType: "image/webp",
          })
        );

        promptImage = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${tempKey}`;
        console.log("Created and uploaded new WebP:", promptImage);
      }

      // Create video task with RunwayML using the SDK
      const response = await this.runwayClient.imageToVideo({
        model: "gen3a_turbo",
        promptImage,
        promptText: "Move forward slowly",
        duration: 5,
        ratio: "768:1280",
      });

      if (!response.id) {
        throw new Error("Failed to create video task");
      }

      // Poll for task completion with exponential backoff
      const taskId = response.id;
      let attempts = 0;
      const maxAttempts = 30; // 5 minutes total with increasing delays
      let delay = 10000; // Start with 10 seconds

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));

        const task = await this.runwayClient.tasks.retrieve(taskId);
        console.log("Task status:", { taskId, status: task.status });

        if (
          task.status === "SUCCEEDED" &&
          task.output &&
          task.output.length > 0
        ) {
          // Download video immediately as URLs are ephemeral
          const videoResponse = await axios.get(task.output[0], {
            responseType: "stream",
          });

          // Save to local file
          const writer = fs.createWriteStream(outputFile);
          videoResponse.data.pipe(writer);

          await new Promise<void>((resolve, reject) => {
            writer.on("finish", () => resolve());
            writer.on("error", (err) => reject(err));
          });

          console.log("Successfully downloaded and saved video:", outputFile);
          return outputFile;
        }

        if (task.status === "FAILED") {
          throw new Error(task.failure || "Video generation failed");
        }

        if (!["PENDING", "RUNNING", "THROTTLED"].includes(task.status)) {
          throw new Error(`Unexpected task status: ${task.status}`);
        }

        // Exponential backoff with max of 30 seconds
        delay = Math.min(delay * 1.5, 30000);
        attempts++;
      }

      throw new Error("Task timed out after maximum polling attempts");
    } catch (error) {
      // Handle specific error cases
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        switch (status) {
          case 400:
            throw new Error(
              `Invalid input parameters: ${
                error.response?.data?.error || error.message
              }`
            );
          case 429:
            throw new Error("Rate limit exceeded. Please try again later.");
          case 502:
          case 503:
          case 504:
            throw new Error(
              "Runway service temporarily unavailable. Please try again later."
            );
          default:
            throw new Error(`Runway API error: ${error.message}`);
        }
      }

      throw new Error(
        `Failed to convert images to video: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private async generateVideoFromExistingWebP(
    filename: string,
    index: number
  ): Promise<string> {
    const maxRetries = 3;
    let retryCount = 0;

    if (!process.env.AWS_REGION) {
      throw new Error("AWS_REGION environment variable is not set");
    }

    while (retryCount < maxRetries) {
      try {
        // Find the WebP version directly from the database
        const photo = await prisma.photo.findFirst({
          where: {
            filePath: {
              contains: filename,
            },
            processedFilePath: { not: null },
          },
          include: {
            listing: true,
          },
        });

        if (!photo?.processedFilePath || !photo.listing) {
          throw new Error(
            `WebP version not found for image: ${filename}. Please ensure images are processed before regeneration.`
          );
        }

        // Use existing WebP file URL directly
        const imageUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${photo.processedFilePath}`;
        console.log("Using existing WebP URL:", imageUrl);

        return this.generateRunwayVideo(imageUrl, index);
      } catch (error) {
        retryCount++;
        console.error("Failed to generate video segment:", {
          error: error instanceof Error ? error.message : "Unknown error",
          filename,
          index,
          attempt: retryCount,
          maxRetries,
        });

        if (retryCount === maxRetries) {
          throw new Error(
            `Failed to generate video segment for image ${index} after ${maxRetries} attempts: ${
              error instanceof Error
                ? error.message
                : "Failed to generate video"
            }`
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retryCount) * 1000)
        );
      }
    }

    throw new Error("Video generation failed after all retries");
  }

  private async generateVideoFirstTime(
    imagePath: string,
    index: number
  ): Promise<string> {
    try {
      // Read and resize the image for Runway's requirements
      const inputBuffer = await readFile(imagePath);
      const webpBuffer = await sharp(inputBuffer)
        .resize(1080, 1920, {
          fit: "cover",
          position: "center",
        })
        .toBuffer();

      // Upload to S3 to get HTTPS URL
      const s3Client = new S3Client({ region: process.env.AWS_REGION });
      const tempKey = `temp/runway-inputs/${Date.now()}-${path.basename(
        imagePath
      )}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET,
          Key: tempKey,
          Body: webpBuffer,
          ContentType: "image/webp",
        })
      );

      // Construct the S3 URL
      const imageUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${tempKey}`;
      console.log("Creating video from new image URL:", imageUrl);

      return this.generateRunwayVideo(imageUrl, index);
    } catch (error) {
      throw new Error(
        `Failed to process image for first-time video generation: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private async generateRunwayVideo(
    imageUrl: string,
    index: number
  ): Promise<string> {
    // Download the image from URL
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });
    const imageBuffer = Buffer.from(imageResponse.data);

    // Check file size (max 16MB unencoded, ~5MB encoded)
    const fileSizeInMB = imageBuffer.length / (1024 * 1024);
    if (fileSizeInMB > 3.3) {
      throw new Error(
        `Image file size (${fileSizeInMB.toFixed(
          2
        )}MB) exceeds Runway's limit of 3.3MB`
      );
    }

    // Validate and process image using sharp
    const imageInfo = await sharp(imageBuffer).metadata();

    // Check image dimensions
    if ((imageInfo.width || 0) > 8000 || (imageInfo.height || 0) > 8000) {
      throw new Error(
        `Image dimensions (${imageInfo.width}x${imageInfo.height}) exceed Runway's limit of 8000px`
      );
    }

    // Convert to WebP format for consistency
    const processedBuffer = await sharp(imageBuffer)
      .resize(1080, 1920, {
        fit: "cover",
        position: "center",
      })
      .webp({ quality: 90 })
      .toBuffer();

    // Create base64 with proper content type
    const base64Image = `data:image/webp;base64,${processedBuffer.toString(
      "base64"
    )}`;

    // Create video generation task with proper headers
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const taskResponse = await axios.post(
      "https://api.runwayml.com/v1/image_to_video",
      {
        model: "gen3a_turbo",
        promptImage: base64Image,
        promptText: "Move forward slowly",
        duration: 5,
        ratio: "768:1280",
      },
      { headers }
    );

    if (!taskResponse.data?.id) {
      throw new Error("Failed to create video task: No task ID received");
    }

    // Poll for task completion
    let task = await this.runwayClient.tasks.retrieve(taskResponse.data.id);
    while (task.status === "PENDING" || task.status === "PROCESSING") {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      task = await this.runwayClient.tasks.retrieve(taskResponse.data.id);

      if (task.status === "FAILED") {
        throw new Error(task.failure || "Video generation failed");
      }

      if (
        task.status === "SUCCEEDED" &&
        task.output &&
        task.output.length > 0
      ) {
        // Download and save the video
        const videoResponse = await fetch(task.output[0]);
        if (!videoResponse.ok) {
          throw new Error(
            `Failed to download video: ${videoResponse.statusText}`
          );
        }

        const segmentPath = path.join(this.outputDir, `segment_${index}.mp4`);
        const videoBuffer = await videoResponse.arrayBuffer();
        await fs.promises.writeFile(segmentPath, Buffer.from(videoBuffer));
        console.log("Successfully downloaded and saved video");
        return segmentPath;
      }
    }

    throw new Error("Video generation timed out");
  }

  private async uploadVideoToS3(videoPath: string): Promise<void> {
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const bucketName = process.env.VIDEOS_BUCKET_NAME;
    const key = `videos/${path.basename(videoPath)}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: await fs.promises.readFile(videoPath),
      ContentType: "video/mp4",
    });

    try {
      await s3Client.send(command);
      console.log(`Video uploaded to S3: ${key}`);
    } catch (error) {
      throw new Error(
        `Failed to upload video to S3: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private async generateVideo(
    image: ProcessedImage,
    outputPath: string
  ): Promise<void> {
    try {
      // Read and resize the image for Runway's requirements
      const inputBuffer = await readFile(image.croppedPath);
      const webpBuffer = await sharp(inputBuffer)
        .resize(1080, 1920, {
          fit: "cover",
          position: "center",
        })
        .toBuffer();

      // Upload to S3 to get HTTPS URL
      const s3Client = new S3Client({ region: process.env.AWS_REGION });
      const tempKey = `temp/runway-inputs/${Date.now()}-${path.basename(
        image.croppedPath
      )}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET,
          Key: tempKey,
          Body: webpBuffer,
          ContentType: "image/webp",
        })
      );

      // Construct the S3 URL
      const imageUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${tempKey}`;
      console.log("Creating video from image URL:", imageUrl);

      // Create video generation task
      const response = await this.runwayClient.imageToVideo({
        model: "gen3a_turbo",
        promptImage: imageUrl,
        promptText: "Move forward slowly",
        duration: 5,
        ratio: "768:1280",
      });

      // Poll for task completion
      let task = await this.runwayClient.tasks.retrieve(response.id);
      while (task.status === "PENDING" || task.status === "PROCESSING") {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        task = await this.runwayClient.tasks.retrieve(response.id);

        if (task.status === "FAILED") {
          throw new Error(task.failure || "Video generation failed");
        }

        if (
          task.status === "SUCCEEDED" &&
          task.output &&
          task.output.length > 0
        ) {
          // Download and save the video
          const videoResponse = await fetch(task.output[0]);
          if (!videoResponse.ok) {
            throw new Error(
              `Failed to download video: ${videoResponse.statusText}`
            );
          }

          const videoBuffer = await videoResponse.arrayBuffer();
          await writeFile(outputPath, Buffer.from(videoBuffer));
          console.log("Successfully downloaded and saved video");
          return;
        }
      }
    } catch (error) {
      console.error("Error generating video:", error);

      // Create a fallback video by copying the original image
      console.log("Creating fallback video by copying the original image");
      await copyFile(image.croppedPath, outputPath);
      console.log(`Created fallback video at: ${outputPath}`);
    }
  }

  async setMapFrames(mapFramesDir: string): Promise<void> {
    const files = await fs.promises.readdir(mapFramesDir);
    this.mapFrames = files
      .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
      .sort()
      .map((f) => path.join(mapFramesDir, f));
  }

  private async stitchVideosWithMapFrames(
    videoFiles: string[],
    durations: number[],
    outputPath: string,
    music?: { path: string; volume?: number }
  ): Promise<void> {
    if (!this.mapFrames) {
      throw new Error("No map frames set. Call setMapFrames first.");
    }

    // Determine segment durations:
    // If durations length equals the number of video files, use them.
    // Else if a single duration is provided, use it for all.
    // Otherwise, throw an error.
    let segmentDurations: number[] = [];
    if (durations.length === videoFiles.length) {
      segmentDurations = durations;
    } else if (durations.length === 1) {
      segmentDurations = Array(videoFiles.length).fill(durations[0]);
    } else {
      throw new Error(
        "Durations array length must be either 1 or equal to number of video files."
      );
    }

    // Ensure we have enough map frames to match the video files.
    if (this.mapFrames.length < videoFiles.length) {
      throw new Error(
        "Not enough map frames set to match video files count. Please check setMapFrames."
      );
    }

    // Create temporary map frame video segments from map frame images.
    const tempMapVideos: string[] = [];
    for (let i = 0; i < videoFiles.length; i++) {
      const mapFrameImage = this.mapFrames[i];
      const duration = segmentDurations[i];
      const tempMapVideoPath = path.join(this.outputDir, `temp_map_${i}.mp4`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(mapFrameImage)
          .inputOptions(["-loop", "1"])
          .duration(duration)
          .videoCodec("libx264")
          .outputOptions(["-pix_fmt", "yuv420p"])
          .on("end", () => resolve())
          .on("error", (err: Error) =>
            reject(
              new Error(
                `Failed to generate map frame video for ${mapFrameImage}: ${err.message}`
              )
            )
          )
          .save(tempMapVideoPath);
      });
      tempMapVideos.push(tempMapVideoPath);
    }

    // Interleave map frame videos and main video segments.
    const filesToConcat: string[] = [];
    for (let i = 0; i < videoFiles.length; i++) {
      filesToConcat.push(tempMapVideos[i]); // Map frame segment.
      filesToConcat.push(videoFiles[i]); // Main video segment.
    }

    // Concatenate all videos into one temporary file.
    const tempConcatPath = path.join(
      this.outputDir,
      `concat_${Date.now()}.mp4`
    );
    await new Promise<void>((resolve, reject) => {
      let command = ffmpeg();
      filesToConcat.forEach((file) => {
        command = command.input(file);
      });
      command
        .on("end", () => resolve())
        .on("error", (err: Error) =>
          reject(new Error(`FFmpeg concatenation error: ${err.message}`))
        )
        .complexFilter([
          {
            filter: "concat",
            options: {
              n: filesToConcat.length,
              v: 1,
              a: 0,
            },
          },
        ])
        .output(tempConcatPath)
        .run();
    });

    // If music is provided, overlay it on the concatenated video.
    if (music && music.path) {
      await new Promise<void>((resolve, reject) => {
        const musicVolume = music.volume !== undefined ? music.volume : 1;
        ffmpeg()
          .input(tempConcatPath)
          .input(music.path)
          .outputOptions(["-c:v copy", "-c:a aac", "-shortest"])
          .audioFilters(`volume=${musicVolume}`)
          .on("end", () => resolve())
          .on("error", (err: Error) =>
            reject(new Error(`FFmpeg music overlay error: ${err.message}`))
          )
          .save(outputPath);
      });
      // Remove temporary concatenated video after overlay.
      await fs.promises.unlink(tempConcatPath);
    } else {
      // No music provided; move the concatenated file to final output.
      await fs.promises.rename(tempConcatPath, outputPath);
    }

    // Cleanup temporary map frame video files.
    await Promise.all(
      tempMapVideos.map(async (tempPath) => {
        try {
          await fs.promises.unlink(tempPath);
        } catch (err) {
          console.warn(`Failed to remove temp file ${tempPath}: ${err}`);
        }
      })
    );
  }

  async createTemplate(
    templateKey: TemplateKey,
    inputVideos: string[],
    mapVideoPath?: string
  ): Promise<string> {
    console.log(
      "Creating template",
      templateKey,
      "with",
      inputVideos.length,
      "videos..."
    );

    const template = reelTemplates[templateKey];
    if (!template) {
      throw new Error(`Template ${templateKey} not found`);
    }

    // Count how many actual image slots we need (excluding map)
    const imageSlots = template.sequence.filter((s) => s !== "map").length;
    const availableImages = inputVideos.length;

    console.log("Template analysis:", {
      totalSlots: template.sequence.length,
      imageSlots,
      availableImages,
      hasMapVideo: !!mapVideoPath,
    });

    // If we have fewer images than slots, adapt the sequence
    let adaptedSequence = [...template.sequence];
    if (availableImages < imageSlots) {
      // Keep the map and use available images in a round-robin fashion
      adaptedSequence = template.sequence.filter((item) => {
        if (item === "map") return true;
        const index = typeof item === "number" ? item : parseInt(item);
        return index < availableImages;
      });

      console.log("Adapted sequence for fewer images:", {
        originalLength: template.sequence.length,
        adaptedLength: adaptedSequence.length,
        sequence: adaptedSequence,
      });
    }

    const clips: VideoClip[] = [];
    for (const sequenceItem of adaptedSequence) {
      if (sequenceItem === "map") {
        if (!mapVideoPath) {
          throw new Error("Map video required but not provided");
        }
        const mapDuration =
          typeof template.durations === "object"
            ? (template.durations as Record<string, number>).map
            : (template.durations as number[])[0];
        clips.push({
          path: mapVideoPath,
          duration: mapDuration,
        });
      } else {
        const index =
          typeof sequenceItem === "number"
            ? sequenceItem
            : parseInt(sequenceItem);
        // Normalize the index to fit within available images
        const normalizedIndex = index % availableImages;
        const duration =
          typeof template.durations === "object"
            ? (template.durations as Record<string, number>)[String(index)]
            : (template.durations as number[])[clips.length];
        clips.push({
          path: inputVideos[normalizedIndex],
          duration,
        });
      }
    }

    await this.ensureDirectoryExists(this.outputDir);
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const outputPath = path.join(
      this.outputDir,
      `${templateKey}-${uniqueId}.mp4`
    );

    console.log("Creating video with adapted sequence:", {
      templateKey,
      clipCount: clips.length,
      totalDuration: clips.reduce((sum, clip) => sum + clip.duration, 0),
    });

    await this.stitchVideos(
      clips.map((clip) => clip.path),
      clips.map((clip) => clip.duration),
      outputPath,
      template.music
    );

    console.log(`${templateKey} video created at: ${outputPath}`);
    return outputPath;
  }

  private async stitchVideos(
    videoFiles: string[],
    durations: number[],
    outputPath: string,
    music?: { path: string; volume?: number; startTime?: number },
    watermark?: { path: string; opacity?: number },
    regeneratedSegments?: { [key: string]: string }
  ): Promise<void> {
    console.log("Starting video stitching with:", {
      videoCount: videoFiles.length,
      durations,
      outputPath,
      hasMusicTrack: !!music,
      hasWatermark: !!watermark,
    });

    // Create filter complex for trimming and scaling videos
    const filterComplex: string[] = [];
    const inputs: string[] = [];

    // Add input files
    for (let i = 0; i < videoFiles.length; i++) {
      inputs.push("-i", videoFiles[i]);
    }

    // Add music input if provided
    if (music) {
      const musicPath = path.resolve(__dirname, music.path);
      if (await exists(musicPath)) {
        inputs.push("-i", musicPath);
      } else {
        console.warn(`Music file not found: ${musicPath}`);
      }
    }

    // Add watermark input if provided
    let watermarkInputIndex = videoFiles.length;
    if (watermark) {
      const watermarkPath = watermark.path;
      if (await exists(watermarkPath)) {
        inputs.push("-i", watermarkPath);
        watermarkInputIndex = inputs.length / 2 - 1; // Calculate the input index for watermark
      } else {
        console.warn(`Watermark file not found: ${watermarkPath}`);
      }
    }

    // Add trim and scale filters for each video
    for (let i = 0; i < videoFiles.length; i++) {
      filterComplex.push(
        `[${i}:v]setpts=PTS-STARTPTS,scale=768:1280:force_original_aspect_ratio=decrease,` +
          `pad=768:1280:(ow-iw)/2:(oh-ih)/2,trim=duration=${durations[i]},` +
          `setpts=PTS-STARTPTS[v${i}]`
      );
    }

    // Create concat inputs string
    const concatInputs = Array.from(
      { length: videoFiles.length },
      (_, i) => `[v${i}]`
    ).join("");

    // Add concat filter
    filterComplex.push(
      `${concatInputs}concat=n=${videoFiles.length}:v=1:a=0[concat]`
    );

    // Add watermark if provided
    if (watermark) {
      const opacity = watermark.opacity || 0.5;
      filterComplex.push(
        `[concat][${watermarkInputIndex}:v]overlay=W-w-10:H-h-10:enable='between(t,0,${durations.reduce(
          (a, b) => a + b,
          0
        )})':alpha=${opacity}[outv]`
      );
    } else {
      filterComplex.push(`[concat]copy[outv]`);
    }

    // Calculate total duration
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);

    // Add audio filters if music is provided
    if (music) {
      const volume = music.volume || 0.5;
      const startTime = music.startTime || 0;
      const fadeStart = Math.max(0, totalDuration - 1);
      filterComplex.push(
        `[${videoFiles.length}:a]asetpts=PTS-STARTPTS,` +
          `atrim=start=${startTime}:duration=${totalDuration},` +
          `volume=${volume}:eval=frame,` +
          `afade=t=out:st=${fadeStart}:d=1[outa]`
      );
    }

    // Build ffmpeg command
    const command = [
      "ffmpeg",
      "-y",
      ...inputs,
      "-filter_complex",
      filterComplex.join(";"),
      "-map",
      "[outv]",
    ];

    // Add audio mapping if music is provided
    if (music) {
      command.push("-map", "[outa]");
    }

    // Add output options
    command.push(
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-r",
      "24",
      "-c:a",
      "aac",
      "-shortest",
      "-t",
      totalDuration.toString(),
      outputPath
    );

    // Execute ffmpeg
    const { spawn } = require("child_process");
    const ffmpeg = spawn(command[0], command.slice(1));

    return new Promise((resolve, reject) => {
      let errorOutput = "";
      ffmpeg.stderr.on("data", (data: Buffer) => {
        const message = data.toString();
        errorOutput += message;
        console.log(`ffmpeg: ${message}`);
      });

      ffmpeg.on("close", (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `ffmpeg exited with code ${code}\nError output: ${errorOutput}`
            )
          );
        }
      });

      ffmpeg.on("error", (err: Error) => {
        reject(
          new Error(
            `ffmpeg process error: ${err.message}\nError output: ${errorOutput}`
          )
        );
      });
    });
  }

  async convertToWebP(
    inputPath: string,
    outputPath: string,
    options: {
      quality: number;
      width: number;
      height: number;
      fit: "cover" | "contain" | "fill";
    }
  ): Promise<string> {
    try {
      await sharp(inputPath)
        .resize(options.width, options.height, { fit: options.fit })
        .webp({ quality: options.quality })
        .toFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error("Error converting to WebP:", error);
      throw error;
    }
  }

  private async uploadToS3ForRunway(
    filePath: string,
    key: string
  ): Promise<string> {
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: key,
      Body: await fs.promises.readFile(filePath),
      ContentType: "application/octet-stream",
    });

    await s3Client.send(command);
    const url = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    console.log("Uploaded file to S3:", url);
    return url;
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

        // Use existing WebP file for regeneration
        const imageUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${photo.processedFilePath}`;

        // Generate new video
        const videoPath = await this.generateRunwayVideo(
          imageUrl,
          parseInt(photo.id)
        );

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
}

// Export singleton instance
export const imageToVideoConverter = new ImageToVideoConverter(
  process.env.RUNWAYML_API_KEY || ""
);
