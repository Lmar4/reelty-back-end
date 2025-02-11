import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from "fluent-ffmpeg";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../lib/prisma";

const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);

export class ThumbnailService {
  private s3Client: S3Client;
  private outputDir: string;

  constructor(outputDir: string = "./temp/thumbnails") {
    this.s3Client = new S3Client({ region: process.env.AWS_REGION });
    this.outputDir = outputDir;
  }

  private async ensureDirectoryExists(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  private async generateThumbnail(videoPath: string): Promise<string> {
    await this.ensureDirectoryExists();
    const thumbnailPath = path.join(this.outputDir, `${Date.now()}.jpg`);

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: ["50%"], // Take screenshot from middle of video
          filename: path.basename(thumbnailPath),
          folder: path.dirname(thumbnailPath),
          size: "1080x1920", // Match video dimensions
        })
        .on("end", () => resolve(thumbnailPath))
        .on("error", (err) => reject(err));
    });
  }

  private async uploadToS3(
    filePath: string,
    templateId: string
  ): Promise<string> {
    const fileContent = await fs.promises.readFile(filePath);
    const key = `thumbnails/templates/${templateId}.jpg`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET!,
        Key: key,
        Body: fileContent,
        ContentType: "image/jpeg",
      })
    );

    return `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }

  async generateAndUploadThumbnail(
    videoPath: string,
    templateId: string
  ): Promise<string> {
    try {
      // Generate thumbnail
      const thumbnailPath = await this.generateThumbnail(videoPath);

      // Upload to S3
      const s3Url = await this.uploadToS3(thumbnailPath, templateId);

      // Update template in database
      await prisma.template.update({
        where: { id: templateId },
        data: { thumbnailUrl: s3Url },
      });

      // Cleanup local file
      await unlink(thumbnailPath);

      return s3Url;
    } catch (error) {
      console.error("[THUMBNAIL_ERROR]", error);
      throw error;
    }
  }
}
