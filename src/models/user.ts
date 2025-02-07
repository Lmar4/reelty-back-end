import { z } from "zod";

// User schemas
export const createUserSchema = z.object({
  body: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string().min(2),
    subscriptionTier: z.string(),
    fcmToken: z.string().nullable().optional(),
  }),
});

export const updateUserSchema = z.object({
  body: z.object({
    email: z.string().email().optional(),
    name: z.string().min(2).optional(),
    subscriptionTier: z.string().optional(),
    fcmToken: z.string().nullable().optional(),
  }),
});

export const getUserSchema = z.object({
  id: z.string().uuid(),
});

// Types
export type CreateUserInput = z.infer<typeof createUserSchema>["body"];
export type UpdateUserInput = z.infer<typeof updateUserSchema>["body"];
export type GetUserInput = z.infer<typeof getUserSchema>;

// Response types
export interface UserResponse {
  id: string;
  email: string;
  name: string;
  subscriptionTier: string;
  fcmToken: string | null;
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
