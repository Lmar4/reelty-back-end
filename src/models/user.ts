import { z } from "zod";
import { SubscriptionTier } from "@prisma/client";

// User schemas
export const createUserSchema = z.object({
  body: z.object({
    id: z.string(),
    email: z.string().email(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    password: z.string(),
  }),
});

export const updateUserSchema = z.object({
  body: z.object({
    email: z.string().email().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    password: z.string().optional(),
  }),
});

export const getUserSchema = z.object({
  id: z.string(),
});

// Types
export type CreateUserInput = z.infer<typeof createUserSchema>["body"];
export type UpdateUserInput = z.infer<typeof updateUserSchema>["body"];
export type GetUserInput = z.infer<typeof getUserSchema>;

// Response types
export interface UserResponse {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeProductId: string | null;
  subscriptionStatus: string | null;
  subscriptionPeriodEnd: Date | null;
  currentTierId: string | null;
  currentTier: SubscriptionTier | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListResponse {
  users: UserResponse[];
  total: number;
  page: number;
  limit: number;
}

export interface ErrorResponse {
  error: string;
  status: number;
}
