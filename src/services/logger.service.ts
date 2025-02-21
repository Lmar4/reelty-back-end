import { PrismaClient, VideoGenerationStatus } from "@prisma/client";

const prisma = new PrismaClient();

export class Logger {
  error(message: string, context: Record<string, any>) {
    console.error(message, context);
    // We can later extend this to use proper logging service

    return prisma.errorLog.create({
      data: {
        userId: context.userId,
        error: message,
        stack: context.error instanceof Error ? context.error.stack : undefined,
      },
    });
  }

  info(message: string, context: Record<string, any>) {
    console.log(message, context);
  }
}

export const logger = new Logger();
