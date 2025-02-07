import express from "express";
import { prisma } from "../lib/prisma";
import { isAuthenticated } from "../middleware/auth";

const router = express.Router();

// Delete user and all associated data
router.delete("/:userId", isAuthenticated, async (req, res) => {
  try {
    const { userId } = req.params;

    // Verify the user is deleting their own account
    if (req.user?.id !== userId) {
      res.status(403).json({ error: "Unauthorized to delete this account" });
      return;
    }

    // Start a transaction to delete all user data
    await prisma.$transaction(async (tx) => {
      // Delete user's video jobs
      await tx.videoJob.deleteMany({
        where: { userId },
      });

      // Delete user's photos
      await tx.photo.deleteMany({
        where: { userId },
      });

      // Delete user's listings
      await tx.listing.deleteMany({
        where: { userId },
      });

      // Delete user's listing credits
      await tx.listingCredit.deleteMany({
        where: { userId },
      });

      // Delete user's credit logs
      await tx.creditLog.deleteMany({
        where: {
          OR: [{ userId }, { adminId: userId }],
        },
      });

      // Delete user's tier changes
      await tx.tierChange.deleteMany({
        where: {
          OR: [{ userId }, { adminId: userId }],
        },
      });

      // Delete user's search history
      await tx.searchHistory.deleteMany({
        where: { userId },
      });

      // Delete user's error logs
      await tx.errorLog.deleteMany({
        where: { userId },
      });

      // Delete user's temp uploads
      await tx.tempUpload.deleteMany({
        where: { userId },
      });

      // Delete user's subscription logs
      await tx.subscriptionLog.deleteMany({
        where: { userId },
      });

      // Finally, delete the user
      await tx.user.delete({
        where: { id: userId },
      });
    });

    res
      .status(200)
      .json({ message: "User and associated data deleted successfully" });
  } catch (error) {
    console.error("[DELETE_USER]", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;
