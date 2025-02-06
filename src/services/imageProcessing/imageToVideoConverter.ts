import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import ffmpeg from "fluent-ffmpeg";
import { RunwayML } from "../runway";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ReelTemplate, TemplateKey, reelTemplates } from "./templates/types";

// Add ProcessedImage type
export interface ProcessedImage {
  croppedPath: string;
  // Add other properties if needed
}

const exists = promisify(fs.exists);
const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const copyFile = promisify(fs.copyFile);

export interface VideoTemplate {
  duration: number;
  transition?: string;
  transitionDuration?: number;
}

export class ImageToVideoConverter {
  private runwayClient: RunwayML;
  private outputDir: string;
  private videoFiles: string[] | null = null;
  private mapFrames: string[] | null = null;

  constructor(apiKey: string, outputDir: string = "./output") {
    if (!apiKey) {
      throw new Error("RunwayML API key is required");
    }
    this.runwayClient = new RunwayML(apiKey);
    this.outputDir = outputDir;
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
    image: string,
    index: number
  ): Promise<string> {
    try {
      // Generate video using our new RunwayML implementation
      const response = await this.runwayClient.generateVideo({
        model: "gen3a_turbo",
        input: {
          images: [image],
          prompt: "Move forward slowly",
          duration: 3, // Default duration per segment
        },
      });

      // Poll for job completion
      let status = response.status;
      while (status === "pending" || status === "processing") {
        await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second polling interval
        const jobStatus = await this.runwayClient.getJobStatus(response.id);
        status = jobStatus.status;

        if (status === "failed") {
          throw new Error("Video generation failed");
        }

        if (status === "completed" && jobStatus.output?.url) {
          // Download and save the video
          const videoResponse = await fetch(jobStatus.output.url);
          if (!videoResponse.ok) {
            throw new Error(
              `Failed to download video: ${videoResponse.statusText}`
            );
          }

          const segmentPath = path.join(this.outputDir, `segment_${index}.mp4`);
          const videoBuffer = await videoResponse.arrayBuffer();
          await fs.promises.writeFile(segmentPath, Buffer.from(videoBuffer));
          return segmentPath;
        }
      }

      throw new Error("Video generation timed out");
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to generate video segment for image ${index}: ${error.message}`
        );
      }
      throw error;
    }
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
    inputImages: string[],
    template: VideoTemplate = { duration: 3 }
  ): Promise<string> {
    try {
      // Validate inputs and prepare directories
      await this.validateImagePaths(inputImages);
      await this.ensureDirectoryExists(this.outputDir);

      // Generate video segments using RunwayML
      const videoSegments = await Promise.all(
        inputImages.map((image, index) =>
          this.generateVideoSegment(image, index)
        )
      );

      // Store generated videos for template use
      this.videoFiles = [...videoSegments];

      // Stitch segments together using ffmpeg
      const finalVideoPath = await this.stitchVideoSegments(
        videoSegments,
        template
      );

      // Upload final video to S3
      await this.uploadVideoToS3(finalVideoPath);

      return finalVideoPath;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to convert images to video: ${error.message}`);
      }
      throw new Error("Failed to convert images to video");
    }
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
      // Read the cropped image using promisified version
      const inputBuffer = await readFile(image.croppedPath);
      const base64String = inputBuffer.toString("base64");

      console.log("Creating video from image:", image.croppedPath);

      // Generate video using our new RunwayML implementation
      const response = await this.runwayClient.generateVideo({
        model: "gen3a_turbo",
        input: {
          images: [`data:image/jpeg;base64,${base64String}`],
          prompt: "Move forward slowly",
          duration: 5,
        },
      });

      // Poll for job completion
      let status = response.status;
      while (status === "pending" || status === "processing") {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        const jobStatus = await this.runwayClient.getJobStatus(response.id);
        status = jobStatus.status;

        if (status === "failed") {
          throw new Error("Video generation failed");
        }

        if (status === "completed" && jobStatus.output?.url) {
          // Download and save the video
          const videoResponse = await fetch(jobStatus.output.url);
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
    videoFiles: string[],
    mapVideoPath?: string,
    subscriptionTier: string = "free",
    watermarkAsset?: { path: string; opacity?: number }
  ): Promise<string> {
    if (!videoFiles.length) {
      throw new Error("No videos provided for template creation");
    }

    await this.ensureDirectoryExists(this.outputDir);
    const template = reelTemplates[templateKey];
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const outputPath = path.join(
      this.outputDir,
      `${templateKey}-${uniqueId}.mp4`
    );

    console.log(
      `Creating template ${templateKey} with ${videoFiles.length} videos...`
    );

    // Add watermark for free tier if watermarkAsset is provided
    const watermark = subscriptionTier === "free" ? watermarkAsset : undefined;

    // Handle different template types
    if (templateKey === "googlezoomintro") {
      if (!mapVideoPath) {
        throw new Error(
          "Map video path is required for googlezoomintro template"
        );
      }

      const orderedVideos: string[] = [];
      const orderedDurations: number[] = [];
      const durations = template.durations as Record<string | number, number>;

      // Process each item in the sequence
      for (const key of template.sequence) {
        if (key === "map") {
          orderedVideos.push(mapVideoPath);
          orderedDurations.push(durations["map"]);
        } else {
          const index = typeof key === "string" ? parseInt(key) : key;
          if (index < 0 || index >= videoFiles.length) {
            throw new Error(
              `Invalid video index ${index} for template ${templateKey}`
            );
          }
          orderedVideos.push(videoFiles[index]);
          orderedDurations.push(durations[key]);
        }
      }

      await this.stitchVideos(
        orderedVideos,
        orderedDurations,
        outputPath,
        template.music,
        watermark
      );
    } else {
      // Regular template processing
      const durations = template.durations as number[];
      const orderedVideos = template.sequence.map((index) => {
        const videoIndex = typeof index === "number" ? index : parseInt(index);
        if (videoIndex < 0 || videoIndex >= videoFiles.length) {
          throw new Error(
            `Invalid video index ${videoIndex} for template ${templateKey}`
          );
        }
        return videoFiles[videoIndex];
      });

      await this.stitchVideos(
        orderedVideos,
        durations,
        outputPath,
        template.music,
        watermark
      );
    }

    console.log(`${templateKey} video created at: ${outputPath}`);
    return outputPath;
  }

  private async stitchVideos(
    videoFiles: string[],
    durations: number[],
    outputPath: string,
    music?: { path: string; volume?: number; startTime?: number },
    watermark?: { path: string; opacity?: number }
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
}

// Export singleton instance
export const imageToVideoConverter = new ImageToVideoConverter(
  process.env.RUNWAYML_API_SECRET || ""
);
