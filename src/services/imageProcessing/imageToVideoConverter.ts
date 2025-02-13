import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { promisify } from "util";
import { RunwayClient } from "../runway";
import { TemplateKey, reelTemplates } from "./templates/types";
import * as os from "os";

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

  private async downloadFromS3(url: string): Promise<Buffer> {
    try {
      // Check if the path is a local file
      if (url.startsWith("/")) {
        return await fs.promises.readFile(url);
      }

      // Handle S3 URL
      const s3Client = new S3Client({
        region: process.env.AWS_REGION || "us-east-2",
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
        },
      });

      let bucket: string;
      let key: string;

      if (url.startsWith("s3://")) {
        // Handle s3:// protocol
        const [, , bucketPart, ...keyParts] = url.split("/");
        bucket = bucketPart;
        key = keyParts.join("/");
      } else {
        // Handle https:// protocol
        const urlObj = new URL(url);
        bucket = urlObj.hostname.split(".")[0];
        // Remove leading slash and decode
        key = decodeURIComponent(urlObj.pathname.substring(1));
      }

      // Remove any query parameters from the key
      key = key.split("?")[0];

      // Validate bucket and key
      if (!bucket || !key) {
        throw new Error(`Invalid S3 URL format: bucket=${bucket}, key=${key}`);
      }

      console.log("Downloading from S3:", { bucket, key });

      // Get object directly from S3
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await s3Client.send(command);

      if (!response.Body) {
        throw new Error("No response body from S3");
      }

      const chunks: Uint8Array[] = [];

      // @ts-ignore - response.Body is a Readable stream
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        throw new Error("Downloaded buffer is empty");
      }

      return buffer;
    } catch (error) {
      console.error("Image download error:", {
        url,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(
        `Failed to download image: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
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
      // Download the image using our S3 download method
      const imageBuffer = await this.downloadFromS3(imageUrl);

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
    } catch (error) {
      throw new Error(
        `Failed to generate video: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
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
    reverse: boolean = false
  ): Promise<void> {
    console.log("Starting video stitching with:", {
      videoCount: videoFiles.length,
      durations,
      outputPath,
      hasMusicTrack: !!music,
      reverse,
    });

    return new Promise((resolve, reject) => {
      let command = ffmpeg();

      // Add input files
      videoFiles.forEach((file) => {
        command = command.input(file);
      });

      // Add music if provided
      if (music) {
        const musicPath = path.resolve(__dirname, music.path);
        if (fs.existsSync(musicPath)) {
          command = command.input(musicPath);
        } else {
          console.warn(`Music file not found: ${musicPath}`);
        }
      }

      // Build complex filter
      const filterComplex: string[] = [];

      // Add trim and scale filters for each video
      videoFiles.forEach((_, i) => {
        filterComplex.push(
          `[${i}:v]setpts=PTS-STARTPTS,scale=768:1280:force_original_aspect_ratio=decrease,` +
            `pad=768:1280:(ow-iw)/2:(oh-ih)/2,trim=duration=${durations[i]},` +
            `${reverse ? "reverse," : ""}setpts=PTS-STARTPTS[v${i}]`
        );
      });

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
      if (music) {
        const opacity = 0.5;
        const totalDuration = durations.reduce((a, b) => a + b, 0);
        filterComplex.push(
          `[concat][${videoFiles.length}:v]overlay=W-w-10:H-h-10:enable='between(t,0,${totalDuration})':alpha=${opacity}[outv]`
        );
      } else {
        filterComplex.push(`[concat]copy[outv]`);
      }

      // Add audio filters if music is provided
      if (music) {
        const volume = music.volume || 0.5;
        const startTime = music.startTime || 0;
        const totalDuration = durations.reduce((a, b) => a + b, 0);
        const fadeStart = Math.max(0, totalDuration - 1);
        filterComplex.push(
          `[${videoFiles.length}:a]asetpts=PTS-STARTPTS,` +
            `atrim=start=${startTime}:duration=${totalDuration},` +
            `volume=${volume}:eval=frame,` +
            `afade=t=out:st=${fadeStart}:d=1[outa]`
        );
      }

      // Apply complex filter
      command = command.complexFilter(filterComplex);

      // Map outputs
      command = command.outputOptions(["-map", "[outv]"]);
      if (music) {
        command = command.outputOptions(["-map", "[outa]"]);
      }

      // Set output options
      command = command
        .outputOptions([
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
        ])
        .output(outputPath);

      // Handle events
      command
        .on("start", (commandLine) => {
          console.log("FFmpeg started:", commandLine);
        })
        .on("progress", (progress) => {
          console.log("FFmpeg progress:", progress);
        })
        .on("end", () => {
          console.log("FFmpeg processing finished");
          resolve();
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(new Error(`FFmpeg error: ${err.message}`));
        });

      // Run the command
      command.run();
    });
  }

  public async validateImage(
    inputPath: string
  ): Promise<{ isValid: boolean; error?: string }> {
    try {
      // If input is a URL, get just the base path without query parameters
      const cleanPath = inputPath.includes("http")
        ? inputPath.split("?")[0]
        : inputPath;

      // Try to load the image with sharp
      const image = sharp(cleanPath);
      const metadata = await image.metadata();

      // Check if it's a valid image format
      if (
        !metadata.format ||
        !["jpeg", "jpg", "png", "webp"].includes(metadata.format)
      ) {
        return {
          isValid: false,
          error: `Unsupported image format: ${metadata.format}`,
        };
      }

      // Check if image dimensions are valid
      if (!metadata.width || !metadata.height) {
        return {
          isValid: false,
          error: "Invalid image dimensions",
        };
      }

      // Check if image is corrupted by trying to get its buffer
      await image.toBuffer();

      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error validating image",
      };
    }
  }

  public async convertToWebP(
    inputPath: string,
    outputPath: string,
    options: {
      quality?: number;
      width?: number;
      height?: number;
      fit?: keyof sharp.FitEnum;
    } = {}
  ): Promise<string> {
    try {
      // If input is a URL, get just the base path without query parameters
      const cleanPath = inputPath.includes("http")
        ? inputPath.split("?")[0]
        : inputPath;

      // Validate the image first
      const validation = await this.validateImage(cleanPath);
      if (!validation.isValid) {
        throw new Error(`Invalid image: ${validation.error}`);
      }

      const image = sharp(cleanPath);

      // Apply resizing if dimensions are provided
      if (options.width || options.height) {
        image.resize(options.width, options.height, {
          fit: options.fit || "contain",
          withoutEnlargement: true,
        });
      }

      // Convert to WebP with specified quality
      await image
        .webp({
          quality: options.quality || 80,
          effort: 4, // Medium compression effort
        })
        .toFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error("Error converting to WebP:", error);
      throw error;
    }
  }

  async processImage(s3Path: string): Promise<{
    localWebpPath: string;
    s3WebpPath: string;
    uploadPromise: Promise<any>;
  }> {
    console.log("Starting image processing:", { s3Path });

    // Parse the original key and create paths
    const { key: originalKey } = this.parseS3Path(s3Path);
    const webpKey = originalKey.replace(/\.[^.]+$/, ".webp");
    const tempDir = process.env.TEMP_OUTPUT_DIR || os.tmpdir();

    // Create consistent file names based on the original key without query params
    const cleanOriginalKey = originalKey.split("?")[0];
    const tempOriginalPath = path.join(
      tempDir,
      path.basename(cleanOriginalKey)
    );
    const tempWebpPath = path.join(tempDir, path.basename(webpKey));

    console.log("Checking paths:", {
      originalKey,
      webpKey,
      tempOriginalPath,
      tempWebpPath,
    });

    try {
      // First check if WebP already exists in temp directory
      if (
        await fs.promises
          .access(tempWebpPath)
          .then(() => true)
          .catch(() => false)
      ) {
        console.log("Found existing WebP in temp directory:", { tempWebpPath });
        return {
          localWebpPath: tempWebpPath,
          s3WebpPath: `s3://${process.env.AWS_BUCKET}/${webpKey}`,
          uploadPromise: Promise.resolve(),
        };
      }

      // Check if original exists in temp directory
      if (
        await fs.promises
          .access(tempOriginalPath)
          .then(() => true)
          .catch(() => false)
      ) {
        console.log("Found original in temp directory:", { tempOriginalPath });
      } else {
        // Check database for existing WebP version
        const existingPhoto = await prisma.photo.findFirst({
          where: { filePath: originalKey, processedFilePath: { not: null } },
        });

        if (existingPhoto?.processedFilePath) {
          console.log("Found existing WebP in database:", {
            processedFilePath: existingPhoto.processedFilePath,
          });
          // Download WebP from S3
          const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${existingPhoto.processedFilePath}`;
          const buffer = await this.downloadFromS3(s3WebpPath);
          await fs.promises.writeFile(tempWebpPath, buffer);

          return {
            localWebpPath: tempWebpPath,
            s3WebpPath,
            uploadPromise: Promise.resolve(),
          };
        }

        // If no WebP exists, download original from S3
        console.log("Downloading original from S3:", { s3Path });
        const imageBuffer = await this.downloadFromS3(s3Path);
        if (!imageBuffer || imageBuffer.length === 0) {
          throw new Error("Downloaded image buffer is empty");
        }
        await fs.promises.writeFile(tempOriginalPath, imageBuffer);
      }

      // At this point we have the original file in temp directory
      // Validate the image
      console.log("Validating image:", { tempOriginalPath });
      const validation = await this.validateImage(tempOriginalPath);
      if (!validation.isValid) {
        throw new Error(`Invalid image: ${validation.error}`);
      }

      // Convert to WebP
      console.log("Converting to WebP:", { tempOriginalPath, tempWebpPath });
      await this.convertToWebP(tempOriginalPath, tempWebpPath, {
        quality: 80,
        width: 1080,
        height: 1920,
        fit: "cover",
      });

      // Create upload promise for S3 and database update
      const s3WebpPath = `s3://${process.env.AWS_BUCKET}/${webpKey}`;
      console.log("Preparing to upload WebP:", { tempWebpPath, s3WebpPath });

      const uploadPromise = this.uploadToS3(tempWebpPath, s3WebpPath)
        .then(async () => {
          await prisma.photo.updateMany({
            where: { filePath: originalKey },
            data: { processedFilePath: webpKey },
          });
          console.log("Updated photo record with WebP path:", {
            original: originalKey,
            webp: webpKey,
          });
        })
        .catch((error) => {
          console.error("WebP upload failed:", {
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
            s3Path: s3WebpPath,
          });
          throw error;
        });

      return {
        localWebpPath: tempWebpPath,
        s3WebpPath,
        uploadPromise,
      };
    } catch (error) {
      // Clean up on error - only delete if files exist
      try {
        if (
          await fs.promises
            .access(tempOriginalPath)
            .then(() => true)
            .catch(() => false)
        ) {
          await fs.promises.unlink(tempOriginalPath);
        }
        if (
          await fs.promises
            .access(tempWebpPath)
            .then(() => true)
            .catch(() => false)
        ) {
          await fs.promises.unlink(tempWebpPath);
        }
        console.log("Cleaned up temp files after error");
      } catch (cleanupError) {
        console.error("Failed to cleanup temp files:", {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : "Unknown error",
          stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
        });
      }

      console.error("Error processing image:", {
        s3Path,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}

// Export singleton instance
export const imageToVideoConverter = new ImageToVideoConverter(
  process.env.RUNWAYML_API_KEY || ""
);
