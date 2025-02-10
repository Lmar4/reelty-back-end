import axios, { AxiosInstance } from "axios";

export class RunwayML {
  private apiKey: string;
  private client: AxiosInstance;
  private readonly baseURL = "https://api.runwayml.com/v1";

  constructor(apiKey: string) {
    console.log("Initializing RunwayML client...");
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getStatus(): Promise<{ status: string }> {
    console.log("Checking RunwayML API status...");
    try {
      const response = await this.client.get("/health");
      console.log("RunwayML API is online");
      return { status: "online" };
    } catch (error) {
      console.error("RunwayML health check failed:", error);
      return { status: "offline" };
    }
  }

  async generateVideo(params: {
    model: string;
    input: {
      images: string[];
      prompt?: string;
      duration?: number;
    };
  }): Promise<{
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    output?: { url: string };
  }> {
    console.log("Generating video with RunwayML:", {
      model: params.model,
      imageCount: params.input.images.length,
      prompt: params.input.prompt,
      duration: params.input.duration,
    });

    try {
      const response = await this.client.post("/inference", {
        model: params.model,
        input: {
          image_urls: params.input.images,
          prompt: params.input.prompt || "Create a smooth transition video",
          duration: params.input.duration || 5,
        },
      });

      console.log("RunwayML video generation initiated:", {
        jobId: response.data.id,
        status: response.data.status,
      });

      return {
        id: response.data.id,
        status: response.data.status,
        output: response.data.output,
      };
    } catch (error) {
      console.error("RunwayML video generation failed:", {
        error: error instanceof Error ? error.message : error,
        params,
      });
      throw new Error("Failed to generate video");
    }
  }

  async getJobStatus(jobId: string): Promise<{
    status: "pending" | "processing" | "completed" | "failed";
    output?: { url: string };
  }> {
    console.log("Checking RunwayML job status:", { jobId });
    try {
      const response = await this.client.get(`/inference/${jobId}`);

      console.log("RunwayML job status retrieved:", {
        jobId,
        status: response.data.status,
        hasOutput: !!response.data.output,
      });

      return {
        status: response.data.status,
        output: response.data.output,
      };
    } catch (error) {
      console.error("RunwayML job status check failed:", {
        jobId,
        error: error instanceof Error ? error.message : error,
      });
      throw new Error("Failed to check job status");
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    console.log("Cancelling RunwayML job:", { jobId });
    try {
      await this.client.delete(`/inference/${jobId}`);
      console.log("RunwayML job cancelled successfully:", { jobId });
    } catch (error) {
      console.error("RunwayML job cancellation failed:", {
        jobId,
        error: error instanceof Error ? error.message : error,
      });
      throw new Error("Failed to cancel job");
    }
  }

  async listModels(): Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      type: string;
    }>
  > {
    console.log("Fetching available RunwayML models...");
    try {
      const response = await this.client.get("/models");
      console.log("RunwayML models retrieved:", {
        modelCount: response.data.models.length,
      });
      return response.data.models;
    } catch (error) {
      console.error("RunwayML models listing failed:", {
        error: error instanceof Error ? error.message : error,
      });
      throw new Error("Failed to list models");
    }
  }
}
