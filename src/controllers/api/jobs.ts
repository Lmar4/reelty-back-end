import { PrismaClient, VideoGenerationStatus } from "@prisma/client";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { z } from "zod";
import { ProductionPipeline } from "../../services/imageProcessing/productionPipeline.js";
import { TemplateKey } from "../../services/imageProcessing/templates/types.js";
const prisma = new PrismaClient();

// Validation schemas
const submitJobSchema = z.object({
  userId: z.string().uuid(),
  listingId: z.string().uuid(),
  images: z.array(z.string().url()).min(1),
  template: z
    .enum(["crescendo", "wave", "storyteller", "googleZoom"])
    .default("crescendo"),
});

const jobIdSchema = z.string().uuid();

export async function submitJob(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Request body is required" }),
      };
    }

    const body = JSON.parse(event.body);
    const validatedData = submitJobSchema.parse(body);

    // Create new job record
    const job = await prisma.videoJob.create({
      data: {
        userId: validatedData.userId,
        listingId: validatedData.listingId,
        inputFiles: validatedData.images,
        template: validatedData.template,
        status: "PENDING" as VideoGenerationStatus,
      },
    });

    // Start processing pipeline with proper error handling
    const pipeline = new ProductionPipeline();

    // Return the job ID immediately, but continue processing in the background
    process.nextTick(async () => {
      try {
        // Update job status to PROCESSING
        await prisma.videoJob.update({
          where: { id: job.id },
          data: { status: "PROCESSING" as VideoGenerationStatus },
        });

        // Execute the pipeline
        await pipeline.execute({
          jobId: job.id,
          inputFiles: validatedData.images,
          template: validatedData.template as TemplateKey,
        });

        // Update job status to COMPLETED on success
        await prisma.videoJob.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED" as VideoGenerationStatus,
            completedAt: new Date(),
          },
        });

        console.log(`Job ${job.id} completed successfully`);
      } catch (error) {
        // Update job status to FAILED on error
        await prisma.videoJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED" as VideoGenerationStatus,
            error: error instanceof Error ? error.message : "Unknown error",
          },
        });

        console.error(`Job ${job.id} failed:`, error);
      }
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
      }),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Validation error",
          details: error.errors,
        }),
      };
    }

    console.error("Error submitting job:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

export async function getJobStatus(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Job ID is required" }),
      };
    }

    // Validate job ID format
    const validatedJobId = jobIdSchema.parse(jobId);

    const job = await prisma.videoJob.findUnique({
      where: { id: validatedJobId },
    });

    if (!job) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        outputFile: job.outputFile,
      }),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Invalid job ID format",
          details: error.errors,
        }),
      };
    }

    console.error("Error fetching job status:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
