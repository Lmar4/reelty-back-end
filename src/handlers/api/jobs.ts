import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import { ProductionPipeline } from "../../../core/src/photo-processing/production-pipeline";
import { z } from "zod";

const prisma = new PrismaClient();

// Validation schemas
const submitJobSchema = z.object({
  userId: z.string().uuid(),
  listingId: z.string().uuid(),
  images: z.array(z.string().url()).min(1),
  template: z.enum(['crescendo', 'wave', 'storyteller', 'googleZoom']).default('crescendo')
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
        status: "pending",
      },
    });

    // Start processing pipeline asynchronously
    const pipeline = new ProductionPipeline(process.env.RUNWAY_API_KEY || "");
    pipeline.runProductionPipeline(job.id).catch(console.error);

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
