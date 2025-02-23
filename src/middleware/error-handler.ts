import { Request, Response, NextFunction } from "express";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { logger } from "../utils/logger.js";

export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error("Request failed", {
    error,
    path: req.path,
    method: req.method,
    query: req.query,
    body: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString(),
  });

  if (error instanceof PrismaClientKnownRequestError) {
    // Handle Prisma specific errors
    return res.status(503).json({
      code: "DATABASE_ERROR",
      message: "Database operation failed",
    });
  }

  return res.status(500).json({
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
  });
};
