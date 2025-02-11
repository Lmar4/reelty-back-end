import RunwayML from "@runwayml/sdk";

export class RunwayClient {
  private client: RunwayML;

  constructor(apiKey: string) {
    console.log("Initializing RunwayML client...");
    this.client = new RunwayML({
      apiKey: apiKey,
      maxRetries: 2,
      timeout: 60000, // 1 minute timeout
    });
  }

  async getStatus(): Promise<{ status: string }> {
    console.log("Checking RunwayML API status...");
    try {
      // Note: Health check endpoint might need to be called differently with the SDK
      const response = await this.client.get("/health");
      console.log("RunwayML API is online");
      return { status: "online" };
    } catch (error) {
      console.error("RunwayML health check failed:", error);
      return { status: "offline" };
    }
  }

  async imageToVideo(params: {
    model: "gen3a_turbo";
    promptImage: string;
    promptText: string;
    duration?: 5 | 10;
    ratio?: "768:1280" | "1280:768";
  }): Promise<{
    id: string;
  }> {
    console.log("Creating image-to-video task with RunwayML:", {
      model: params.model,
      promptText: params.promptText,
      duration: params.duration,
      ratio: params.ratio,
    });

    try {
      const response = await this.client.imageToVideo.create({
        model: params.model,
        promptImage: params.promptImage,
        promptText: params.promptText || "Create a smooth transition video",
        duration: params.duration || 5,
        ratio: params.ratio || "768:1280",
      });

      console.log("RunwayML task created:", {
        taskId: response.id,
      });

      return {
        id: response.id,
      };
    } catch (error) {
      if (error instanceof RunwayML.APIError) {
        console.error("RunwayML task creation failed:", {
          status: error.status,
          name: error.name,
          message: error.message,
        });
      } else {
        console.error("RunwayML task creation failed:", error);
      }
      throw error;
    }
  }

  tasks = {
    retrieve: async (
      taskId: string
    ): Promise<{
      status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED";
      failure?: string;
      output?: string[];
    }> => {
      console.log("Checking RunwayML task status:", { taskId });
      try {
        const task = await this.client.tasks.retrieve(taskId);

        console.log("RunwayML task status retrieved:", {
          taskId,
          status: task.status,
          hasOutput: !!task.output,
        });

        return {
          status: task.status as
            | "PENDING"
            | "PROCESSING"
            | "SUCCEEDED"
            | "FAILED",
          failure: task.failure,
          output: task.output,
        };
      } catch (error) {
        console.error("RunwayML task status check failed:", {
          taskId,
          error: error instanceof Error ? error.message : error,
        });
        throw error;
      }
    },
  };

  async cancelTask(taskId: string): Promise<void> {
    console.log("Cancelling RunwayML task:", { taskId });
    try {
      await this.client.tasks.delete(taskId);
      console.log("RunwayML task cancelled successfully:", { taskId });
    } catch (error) {
      console.error("RunwayML task cancellation failed:", {
        taskId,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }
}
