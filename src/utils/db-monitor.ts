import { PrismaClient } from "@prisma/client";
import winston from "winston";

export class DatabaseMonitor {
  private checkInterval!: NodeJS.Timeout;

  constructor(
    private prisma: PrismaClient,
    private logger: winston.Logger,
    private intervalMs = 5000
  ) {}

  start() {
    this.checkInterval = setInterval(async () => {
      try {
        const result = await this.prisma.$queryRaw`SELECT 1`;
        if (result) {
          this.logger.debug("Database connection healthy");
        }
      } catch (error) {
        this.logger.error("Database connection check failed", { error });
      }
    }, this.intervalMs);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}
