import RunwayML from "@runwayml/sdk";
import { tempFileManager } from "../storage/temp-file.service";
import { s3Service } from "../storage/s3.service";
import { imageProcessor } from "../imageProcessing/image.service";
import * as fs from "fs/promises";

// Our custom constraints on the SDK types
type RunwayModel = "gen3a_turbo";
type RunwayRatio = "768:1280";
type RunwayDuration = 5 | 10;

interface ImageToVideoCreateParams {
  model: RunwayModel;
  promptImage: string;
  promptText: string;
  duration: RunwayDuration;
  ratio: RunwayRatio;
}

export class RunwayService {
  private static instance: RunwayService;
  private client: RunwayML;

  private constructor(apiKey: string) {
    if (!apiKey) throw new Error("RunwayML API key is required");
    this.client = new RunwayML({ apiKey });
  }

  public static getInstance(
    apiKey: string = process.env.RUNWAYML_API_KEY || ""
  ): RunwayService {
    if (!RunwayService.instance) {
      RunwayService.instance = new RunwayService(apiKey);
    }
    return RunwayService.instance;
  }

  public async generateVideo(imageUrl: string, index: number): Promise<string> {
    try {
      // Create task
      const taskId = await this.createTask(imageUrl, index);
      console.log("Task created on Runway:", { taskId });

      // Poll for completion
      const status = await this.pollTaskStatus(taskId);
      if (status !== "SUCCEEDED") {
        throw new Error(
          `Video generation was ${status.toLowerCase()} due to rate limits`
        );
      }

      // Download result
      const localPath = await this.downloadResult(taskId, index);

      // Return just the local path
      return localPath;
    } catch (error) {
      console.error("Failed to generate video:", error);
      throw error;
    }
  }

  private async createTask(imageUrl: string, index: number): Promise<string> {
    console.log("Starting video generation:", { imageUrl, index });

    // Download the image from S3 and convert to data URL
    const imageBuffer = await s3Service.downloadFile(imageUrl);
    const dataUrl = await imageProcessor.bufferToDataUrl(imageBuffer);

    const imageToVideo = await this.client.imageToVideo.create({
      model: "gen3a_turbo",
      promptImage: dataUrl,
      promptText: "Move forward slowly",
      duration: 5,
      ratio: "768:1280",
    });

    if (!imageToVideo?.id) throw new Error("No task ID received");
    return imageToVideo.id;
  }

  private async pollTaskStatus(taskId: string): Promise<string> {
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes maximum (10 second intervals * 30)

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      const task = await this.client.tasks.retrieve(taskId);
      attempts++;

      console.log("Status:", {
        taskId,
        status: task.status,
        attempt: attempts,
        maxAttempts,
      });

      if (task.status === "FAILED") {
        throw new Error(task.failure || "Video generation failed");
      }
      if (task.status === "CANCELLED") {
        throw new Error("Video generation was cancelled");
      }
      if (task.status === "THROTTLED") {
        throw new Error("Video generation was throttled due to rate limits");
      }
      if (task.status === "SUCCEEDED") {
        return task.status;
      }
    }

    throw new Error("Video generation timed out after 5 minutes");
  }

  private async downloadResult(taskId: string, index: number): Promise<string> {
    const task = await this.client.tasks.retrieve(taskId);

    if (!task.output?.[0]) {
      throw new Error("No video output URL found");
    }

    const videoResponse = await fetch(task.output[0]);
    if (!videoResponse.ok) {
      throw new Error(`Download failed: ${videoResponse.statusText}`);
    }

    const tempFile = await tempFileManager.createTempPath(
      `segment_${index}.mp4`
    );
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    await tempFileManager.writeFile(tempFile, videoBuffer);

    // Upload to S3 in background
    const s3Key = `videos/runway/${Date.now()}_segment_${index}.mp4`;
    const s3Url = s3Service.getPublicUrl(process.env.AWS_BUCKET || "");

    // Start upload but don't await it
    fs.readFile(tempFile.path)
      .then((buffer) => s3Service.uploadFile(buffer, s3Key))
      .catch((error) => {
        console.error("Failed to upload video to S3:", error);
      });

    console.log("Video saved:", {
      taskId,
      localPath: tempFile.path,
      s3Url,
    });

    return tempFile.path;
  }
}

export const runwayService = RunwayService.getInstance();
