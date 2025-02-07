import { Router, Request, Response, NextFunction } from "express";
import {
  checkCredits,
  deductCredits,
  getCreditHistory,
  purchaseCredits,
} from "../controllers/api/credits";
import { validateRequest } from "../middleware/auth";

const router = Router();

// Apply authentication middleware to all routes
const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await validateRequest(req);
    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized" });
  }
};

router.use(authMiddleware);

// Credit management routes
router.post("/check", checkCredits);
router.post("/deduct", deductCredits);
router.get("/history/:userId", getCreditHistory);
router.post("/purchase", purchaseCredits);

export default router;
