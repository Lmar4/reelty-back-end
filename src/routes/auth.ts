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
// Route handlers
router.get("/token", getAuthToken);

export default router;
