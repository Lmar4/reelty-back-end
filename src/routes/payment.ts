import express, { RequestHandler } from "express";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { getAuth } from "@clerk/express";
import Stripe from "stripe";
import { createApiResponse } from "../types/api.js";
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-01-27.acacia",
});

// Validation schemas
const setupIntentSchema = z.object({
  body: z.object({
    customerId: z.string().min(1),
  }),
});

const listPaymentMethodsSchema = z.object({
  query: z.object({
    customerId: z.string().min(1),
  }),
});

const deletePaymentMethodSchema = z.object({
  body: z.object({
    paymentMethodId: z.string().min(1),
  }),
});

const updateDefaultPaymentMethodSchema = z.object({
  body: z.object({
    customerId: z.string().min(1),
    paymentMethodId: z.string().min(1),
  }),
});

// Create SetupIntent for adding a new payment method
const createSetupIntent: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { customerId } = req.body;

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session", // Allow using this payment method for future payments
    });

    res.json(
      createApiResponse(true, {
        clientSecret: setupIntent.client_secret,
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
          error instanceof Error
            ? error.message
            : "Failed to create setup intent"
        )
      );
  }
};

// List payment methods for a customer
const listPaymentMethods: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { customerId } = req.query;

    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId as string,
      type: "card",
    });

    // Get the default payment method
    const customer = await stripe.customers.retrieve(customerId as string);
    const defaultPaymentMethodId =
      typeof customer === "object" && !("deleted" in customer)
        ? customer.invoice_settings?.default_payment_method
        : null;

    const formattedPaymentMethods = paymentMethods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand,
      last4: pm.card?.last4,
      expMonth: pm.card?.exp_month,
      expYear: pm.card?.exp_year,
      isDefault: pm.id === defaultPaymentMethodId,
    }));

    res.json({
      success: true,
      data: formattedPaymentMethods,
    });
  } catch (error) {
    console.error("List payment methods error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Delete a payment method
const deletePaymentMethod: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { paymentMethodId } = req.body;

    await stripe.paymentMethods.detach(paymentMethodId);

    res.json(
      createApiResponse(true, null, "Payment method deleted successfully")
    );
  } catch (error) {
    res
      .status(500)
      .json(
        createApiResponse(
          false,
          undefined,
          undefined,
          error instanceof Error
            ? error.message
            : "Failed to delete payment method"
        )
      );
  }
};

// Update default payment method
const updateDefaultPaymentMethod: RequestHandler = async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { customerId, paymentMethodId } = req.body;

    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    res.json({
      success: true,
      message: "Default payment method updated successfully",
    });
  } catch (error) {
    console.error("Update default payment method error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
};

// Route handlers
router.post(
  "/setup-intent",
  validateRequest(setupIntentSchema),
  createSetupIntent
);
router.get(
  "/methods",
  validateRequest(listPaymentMethodsSchema),
  listPaymentMethods
);
router.delete(
  "/method",
  validateRequest(deletePaymentMethodSchema),
  deletePaymentMethod
);
router.post(
  "/method/default",
  validateRequest(updateDefaultPaymentMethodSchema),
  updateDefaultPaymentMethod
);

export default router;
