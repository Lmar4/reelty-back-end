import express, { RequestHandler } from "express";
import { getAuth } from "@clerk/express";

const router = express.Router();

// Get auth token
const getAuthToken: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.sessionId) {
      res.status(401).json({
        error: "Unauthorized",
        status: 401,
      });
      return;
    }

    // Return the session token or generate a custom token as needed
    res.json({
      token: auth.getToken(), // You might want to customize this based on your needs
      status: 200,
    });
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({
      error: "Failed to generate token",
      status: 500,
    });
  }
};

// Route handlers
router.get("/token", getAuthToken);

export default router;
