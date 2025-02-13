import RunwayML from "@runwayml/sdk";
import { tempFileManager } from "../storage/temp-file.service";
import { s3Service } from "../storage/s3.service";
import { imageProcessor } from "../imageProcessing/image.service";

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

      console.log("Task created:", { taskId: imageToVideo.id });

      let task;
      let attempts = 0;
      const maxAttempts = 30; // 5 minutes maximum (10 second intervals * 30)

      do {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        task = await this.client.tasks.retrieve(imageToVideo.id);
        attempts++;

        console.log("Status:", {
          taskId: imageToVideo.id,
          status: task.status,
          attempt: attempts,
          maxAttempts,
        });

        if (attempts >= maxAttempts) {
          throw new Error("Video generation timed out after 5 minutes");
        }

        if (task.status === "FAILED") {
          throw new Error(task.failure || "Video generation failed");
        }
      } while (!["SUCCEEDED", "FAILED"].includes(task.status));

      if (task.status === "SUCCEEDED" && task.output?.[0]) {
        const videoResponse = await fetch(task.output[0]);
        if (!videoResponse.ok)
          throw new Error(`Download failed: ${videoResponse.statusText}`);

        const tempFile = await tempFileManager.createTempPath(
          `segment_${index}.mp4`
        );
        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
        await tempFileManager.writeFile(tempFile, videoBuffer);

        console.log("Video saved:", {
          taskId: imageToVideo.id,
          path: tempFile.path,
        });
        return tempFile.path;
      }

      throw new Error("No output produced");
    } catch (error) {
      console.error("Generation failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        imageUrl,
        index,
      });
      throw error;
    }
  }
}

export const runwayService = RunwayService.getInstance();
