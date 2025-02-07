import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { VisionProcessor } from "../../services/imageProcessing/visionProcessor";
import * as path from "path";

const prisma = new PrismaClient();
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
});

const photoUploadSchema = z.object({
  listingId: z.string().uuid(),
  contentType: z.enum(["image/jpeg", "image/png"]),
  fileName: z.string().min(1),
  fileSize: z
    .number()
    .min(1)
    .max(10 * 1024 * 1024), // 10MB max
  tempFilePath: z.string().optional(), // Optional temporary file path for WebP conversion
  filePath: z.string(), // Required for photo upload
  userId: z.string().uuid(), // Add userId to schema
});

type PhotoUploadRequest = z.infer<typeof photoUploadSchema>;

export async function handlePhotoUpload(
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
    const validatedData = photoUploadSchema.parse(body);

    const visionProcessor = new VisionProcessor();
    const webpPath = await visionProcessor.convertToWebP(
      validatedData.filePath
    );

    // Verify listing exists
    const listing = await prisma.listing.findUnique({
      where: { id: validatedData.listingId },
      include: { photos: true },
    });

    if (!listing) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Listing not found" }),
      };
    }

    // Check photo limit
    if (listing.photos.length >= listing.photoLimit) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Photo limit reached for this listing" }),
      };
    }

    // Generate S3 key and signed URL
    const key = `photos/${
      validatedData.listingId
    }/${Date.now()}-${path.basename(webpPath)}`;
    const command = new PutObjectCommand({
      Bucket: process.env.PHOTOS_BUCKET_NAME,
      Key: key,
      ContentType: "image/webp",
    });

    const signedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    // Create photo record in database
    const photo = await prisma.photo.create({
      data: {
        userId: validatedData.userId,
        listingId: validatedData.listingId,
        filePath: `s3://${process.env.PHOTOS_BUCKET_NAME}/${key}`,
      },
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        photoId: photo.id,
        uploadUrl: signedUrl,
        key: key,
        expiresIn: 3600,
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

    console.error("Error handling photo upload:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
