import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

const notificationSchema = z.object({
  userId: z.string().uuid(),
  jobId: z.string().uuid(),
  jobStatus: z.enum(["pending", "processing", "completed", "error"]),
});

export async function sendJobStatusNotification(
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
    const validatedData = notificationSchema.parse(body);

    // Get user's notification settings from database
    const user = await prisma.user.findUnique({
      where: { id: validatedData.userId },
      select: {
        email: true,
        name: true,
        fcmToken: true,
      },
    });

    if (!user?.email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "User has no email registered" }),
      };
    }

    // Get job details
    const job = await prisma.videoJob.findUnique({
      where: { id: validatedData.jobId },
      include: { listing: true },
    });

    if (!job) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    // Prepare notification message
    const message = {
      default: `Your video for ${job.listing.address} is ${validatedData.jobStatus}`,
      email: `
        <h2>Video Job Update</h2>
        <p>Your video for ${job.listing.address} is now ${
        validatedData.jobStatus
      }.</p>
        <p>Job Details:</p>
        <ul>
          <li>Job ID: ${validatedData.jobId}</li>
          <li>Status: ${validatedData.jobStatus}</li>
          <li>Updated: ${new Date().toLocaleString()}</li>
        </ul>
      `,
      sms: `Reelty: Your video for ${job.listing.address} is ${validatedData.jobStatus}`,
    };

    // Send notification through SNS
    const command = new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: JSON.stringify(message),
      MessageStructure: "json",
      Subject: "Video Job Update",
    });

    const response = await snsClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        messageId: response.MessageId,
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

    console.error("Error sending notification:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to send notification" }),
    };
  }
}
