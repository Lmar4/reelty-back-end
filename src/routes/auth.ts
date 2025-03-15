import express, { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { createApiResponse } from "../types/api.js";
const router = express.Router();

// Get auth token
const getAuthToken: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.sessionId) {
      res
        .status(401)
        .json(createApiResponse(false, undefined, undefined, "Unauthorized"));
      return;
    }

    res.json(
      createApiResponse(true, {
        token: auth.getToken(),
        status: 200,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Failed to generate token"
        )
      );
  }
};

// Add this new debug endpoint
const debugAuth: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    const { userId, sessionId } = auth;

    // Get token details without exposing the full token
    const token = req.headers.authorization;
    const tokenDetails = token
      ? {
          present: true,
          format: token.startsWith("Bearer ") ? "valid" : "invalid",
          prefix: token.startsWith("Bearer ")
            ? token.substring(7, 17) + "..."
            : "N/A",
        }
      : { present: false };

    res.json(
      createApiResponse(true, {
        auth: {
          userId,
          sessionId: sessionId ? "present" : "missing",
          hasValidSession: !!(userId && sessionId),
        },
        token: tokenDetails,
        headers: {
          host: req.headers.host,
          origin: req.headers.origin,
          userAgent: req.headers["user-agent"],
        },
        server: {
          env: process.env.NODE_ENV,
          hasClerkSecret: !!process.env.CLERK_SECRET_KEY,
        },
      })
    );
  } catch (error) {
    res.status(500).json(
      createApiResponse(
        false,
        {
          error: error instanceof Error ? error.message : "Unknown error",
          hasAuth: !!req.headers.authorization,
          authPrefix: req.headers.authorization
            ? req.headers.authorization.startsWith("Bearer ")
              ? "Bearer"
              : "Invalid"
            : "Missing",
        },
        undefined,
        "Auth debug failed"
      )
    );
  }
};

// Route handlers
router.get("/token", getAuthToken);
router.get("/debug", debugAuth);

export default router;
