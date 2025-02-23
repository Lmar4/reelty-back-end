import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

export const timeoutMiddleware =
  (timeout = 30000) =>
  (req: Request, res: Response, next: NextFunction) => {
    // Set timeout for all requests
    res.setTimeout(timeout, () => {
      logger.error("Request timeout", {
        path: req.path,
        method: req.method,
        duration: timeout,
      });

      res.status(504).json({
        code: "TIMEOUT",
        message: "Request timed out",
      });
    });

    next();
  };
