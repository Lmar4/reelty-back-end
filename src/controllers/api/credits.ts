import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { createApiResponse } from "../../types/api.js";

interface ListingCredit {
  id: string;
  userId: string;
  creditsRemaining: number;
  expiryDate: Date;
}

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia",
});

export const getBalance = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res
        .status(401)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "User not authenticated"
          )
        );
      return;
    }

    const listingCredits = await prisma.listingCredit.findMany({
      where: {
        userId,
        creditsRemaining: { gt: 0 },
      },
    });

    const totalCredits = listingCredits.reduce(
      (sum, credit) => sum + credit.creditsRemaining,
      0
    );

    // Get used credits from credit log
    const usedCredits = await prisma.creditLog.aggregate({
      where: {
        userId,
        amount: { lt: 0 }, // Only count negative amounts (used credits)
      },
      _sum: {
        amount: true,
      },
    });

    const total = totalCredits;
    const used = Math.abs(usedCredits._sum.amount || 0);
    const available = total - used;

    res.json(
      createApiResponse(true, {
        total,
        available,
        used,
      })
    );
  } catch (error) {
    console.error("[GET_BALANCE_ERROR]", error);
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Failed to get credit balance"
        )
      );
  }
};

export const checkCredits = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res
        .status(401)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "User not authenticated"
          )
        );
      return;
    }

    const listingCredits = await prisma.listingCredit.findMany({
      where: {
        userId,
        creditsRemaining: { gt: 0 },
      },
    });

    const totalCredits = listingCredits.reduce(
      (sum, credit) => sum + credit.creditsRemaining,
      0
    );

    res.json(createApiResponse(true, { credits: totalCredits }));
  } catch (error) {
    console.error("[CHECK_CREDITS_ERROR]", error);
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Failed to check credits"
        )
      );
  }
};

export const deductCredits = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res
        .status(401)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "User not authenticated"
          )
        );
      return;
    }

    const { amount, reason } = req.body;

    // Start transaction
    const result = await prisma.$transaction(async (prisma) => {
      // Get valid listing credits
      const listingCredits = await prisma.listingCredit.findMany({
        where: {
          userId,
          creditsRemaining: { gt: 0 },
        },
        orderBy: { createdAt: "asc" }, // Use oldest credits first
      });

      // Calculate total available credits
      const totalCredits = listingCredits.reduce(
        (sum, credit) => sum + credit.creditsRemaining,
        0
      );

      if (totalCredits < amount) {
        throw new Error("Insufficient credits");
      }

      let remainingToDeduct = amount;

      // Deduct credits from listing credits
      for (const credit of listingCredits) {
        if (remainingToDeduct <= 0) break;

        const deduction = Math.min(credit.creditsRemaining, remainingToDeduct);
        await prisma.listingCredit.update({
          where: { id: credit.id },
          data: {
            creditsRemaining: credit.creditsRemaining - deduction,
          },
        });

        remainingToDeduct -= deduction;
      }

      // Log the deduction
      await prisma.creditLog.create({
        data: {
          userId,
          amount: -amount,
          reason,
        },
      });

      return { success: true };
    });

    res.json(createApiResponse(true, result));
  } catch (error) {
    console.error("[DEDUCT_CREDITS_ERROR]", error);
    if (error instanceof Error && error.message === "Insufficient credits") {
      res
        .status(400)
        .json(
          createApiResponse(false, undefined, undefined, "Insufficient credits")
        );
      return;
    }
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Failed to deduct credits"
        )
      );
  }
};

export const getCreditHistory = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const authUserId = req.user?.id;
    if (!authUserId) {
      res
        .status(401)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "User not authenticated"
          )
        );
      return;
    }

    const { userId } = req.params;

    // Only allow users to view their own credit history
    if (userId !== authUserId) {
      res
        .status(403)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "Not authorized to view this credit history"
          )
        );
      return;
    }

    const creditLogs = await prisma.creditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50, // Limit to last 50 transactions
    });

    res.json(createApiResponse(true, creditLogs));
  } catch (error) {
    console.error("[CREDIT_HISTORY_ERROR]", error);
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Failed to fetch credit history"
        )
      );
  }
};

export const purchaseCredits = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { amount, priceId } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res
        .status(401)
        .json(
          createApiResponse(
            false,
            undefined,
            undefined,
            "User not authenticated"
          )
        );
      return;
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/billing?credits_purchased=true`,
      cancel_url: `${process.env.FRONTEND_URL}/billing?canceled=true`,
      metadata: {
        userId,
        credits: amount.toString(),
        type: "credit_purchase",
      },
    });

    res.json(createApiResponse(true, { url: session.url }));
  } catch (error) {
    console.error("[PURCHASE_CREDITS_ERROR]", error);
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          "Failed to create checkout session"
        )
      );
  }
};
