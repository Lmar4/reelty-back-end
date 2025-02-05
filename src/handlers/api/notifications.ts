import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getMessaging } from 'firebase-admin/messaging';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const notificationSchema = z.object({
  userId: z.string().uuid(),
  jobId: z.string().uuid(),
  jobStatus: z.enum(['pending', 'processing', 'completed', 'error'])
});

export async function sendJobStatusNotification(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Request body is required' })
      };
    }

    const body = JSON.parse(event.body);
    const validatedData = notificationSchema.parse(body);

    // Get user's FCM token from database
    const user = await prisma.user.findUnique({
      where: { id: validatedData.userId }
    });

    if (!user?.fcmToken) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'User has no FCM token registered' })
      };
    }

    // Get job details
    const job = await prisma.videoJob.findUnique({
      where: { id: validatedData.jobId },
      include: { listing: true }
    });

    if (!job) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Job not found' })
      };
    }

    // Prepare notification message
    const message = {
      notification: {
        title: 'Video Job Update',
        body: `Your video for ${job.listing.address} is ${validatedData.jobStatus}`
      },
      data: {
        jobId: validatedData.jobId,
        status: validatedData.jobStatus,
        timestamp: new Date().toISOString()
      },
      token: user.fcmToken
    };

    // Send notification
    const response = await getMessaging().send(message);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        messageId: response
      })
    };

  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Validation error', 
          details: error.errors 
        })
      };
    }

    console.error('Error sending notification:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to send notification' })
    };
  }
}
