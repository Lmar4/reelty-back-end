import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// Validation schemas
const uploadRequestSchema = z.object({
  fileType: z.enum(['image/jpeg', 'image/png']),
  fileName: z.string().min(1),
  contentLength: z.number().min(1).max(10 * 1024 * 1024) // 10MB max
});

export async function getUploadUrl(
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
    const validatedData = uploadRequestSchema.parse(body);

    const key = `uploads/${Date.now()}-${validatedData.fileName}`;
    const command = new PutObjectCommand({
      Bucket: process.env.UPLOAD_BUCKET_NAME,
      Key: key,
      ContentType: validatedData.fileType
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return {
      statusCode: 200,
      body: JSON.stringify({
        uploadUrl: signedUrl,
        key: key,
        expiresIn: 3600
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

    console.error('Error generating upload URL:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}
