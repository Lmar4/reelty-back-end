import axios, { AxiosInstance } from "axios";

export class RunwayML {
  private apiKey: string;
  private client: AxiosInstance;
  private readonly baseURL = "https://api.runwayml.com/v1";

  constructor(apiKey: string) {
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
    try {
      const response = await this.client.get("/health");
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
    try {
      const response = await this.client.post("/inference", {
        model: params.model,
        input: {
          image_urls: params.input.images,
          prompt: params.input.prompt || "Create a smooth transition video",
          duration: params.input.duration || 5,
        },
      });

      return {
        id: response.data.id,
        status: response.data.status,
        output: response.data.output,
      };
    } catch (error) {
      console.error("RunwayML video generation failed:", error);
      throw new Error("Failed to generate video");
    }
  }

  async getJobStatus(jobId: string): Promise<{
    status: "pending" | "processing" | "completed" | "failed";
    output?: { url: string };
  }> {
    try {
      const response = await this.client.get(`/inference/${jobId}`);

      return {
        status: response.data.status,
        output: response.data.output,
      };
    } catch (error) {
      console.error("RunwayML job status check failed:", error);
      throw new Error("Failed to check job status");
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    try {
      await this.client.delete(`/inference/${jobId}`);
    } catch (error) {
      console.error("RunwayML job cancellation failed:", error);
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
    try {
      const response = await this.client.get("/models");
      return response.data.models;
    } catch (error) {
      console.error("RunwayML models listing failed:", error);
      throw new Error("Failed to list models");
    }
  }
}
