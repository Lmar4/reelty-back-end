import { z } from "zod";
import { UserRole, SubscriptionStatus } from "@prisma/client";

// Define enums that aren't yet available in @prisma/client
export enum UserType {
  INDIVIDUAL = "INDIVIDUAL",
  AGENCY = "AGENCY",
  AGENCY_MEMBER = "AGENCY_MEMBER",
}

export enum UserStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  SUSPENDED = "SUSPENDED",
}

export enum BillingStatus {
  PENDING = "PENDING",
  PAID = "PAID",
  FAILED = "FAILED",
  REFUNDED = "REFUNDED",
}

export enum AgencyRole {
  OWNER = "OWNER",
  ADMIN = "ADMIN",
  MEMBER = "MEMBER",
}

export enum MembershipStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  PENDING = "PENDING",
}

export enum InvitationStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  DECLINED = "DECLINED",
  EXPIRED = "EXPIRED",
}

export enum ResourceType {
  CREDIT = "CREDIT",
  STORAGE = "STORAGE",
  LISTING = "LISTING",
  VIDEO = "VIDEO",
}

export enum AllocationPeriod {
  ONCE = "ONCE",
  DAILY = "DAILY",
  WEEKLY = "WEEKLY",
  MONTHLY = "MONTHLY",
  YEARLY = "YEARLY",
}

// User schemas
export const createUserSchema = z.object({
  body: z.object({
    id: z.string(),
    email: z.string().email(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    password: z.string().optional(),
    role: z.nativeEnum(UserRole).optional().default(UserRole.USER),
    type: z.nativeEnum(UserType).optional().default(UserType.INDIVIDUAL),
    status: z.nativeEnum(UserStatus).optional().default(UserStatus.ACTIVE),
    timeZone: z.string().optional(),
  }),
});

export const updateUserSchema = z.object({
  body: z.object({
    email: z.string().email().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    password: z.string().optional(),
    role: z.nativeEnum(UserRole).optional(),
    type: z.nativeEnum(UserType).optional(),
    status: z.nativeEnum(UserStatus).optional(),
    timeZone: z.string().optional(),
    notificationSettings: z.record(z.boolean()).optional(),
  }),
});

export const getUserSchema = z.object({
  id: z.string(),
});

// Agency schemas
export const createAgencyMembershipSchema = z.object({
  body: z.object({
    agencyId: z.string(),
    userId: z.string(),
    role: z.nativeEnum(AgencyRole).optional().default(AgencyRole.MEMBER),
    canManageCredits: z.boolean().optional().default(false),
    canInviteMembers: z.boolean().optional().default(false),
    accessibleResourceTypes: z.array(z.string()).optional().default([]),
    creditAllocation: z.number().optional().default(0),
  }),
});

export const updateAgencyMembershipSchema = z.object({
  body: z.object({
    role: z.nativeEnum(AgencyRole).optional(),
    status: z.nativeEnum(MembershipStatus).optional(),
    canManageCredits: z.boolean().optional(),
    canInviteMembers: z.boolean().optional(),
    accessibleResourceTypes: z.array(z.string()).optional(),
    creditAllocation: z.number().optional(),
  }),
});

export const createAgencyInvitationSchema = z.object({
  body: z.object({
    agencyId: z.string(),
    email: z.string().email(),
    role: z.nativeEnum(AgencyRole).optional().default(AgencyRole.MEMBER),
  }),
});

// Subscription schemas
export const createSubscriptionSchema = z.object({
  body: z.object({
    userId: z.string(),
    tierId: z.string(),
    status: z
      .nativeEnum(SubscriptionStatus)
      .optional()
      .default(SubscriptionStatus.ACTIVE),
    stripeCustomerId: z.string().optional(),
    stripeSubscriptionId: z.string().optional(),
    stripePriceId: z.string().optional(),
    billingEmail: z.string().email().optional(),
    autoRenew: z.boolean().optional().default(true),
  }),
});

export const updateSubscriptionSchema = z.object({
  body: z.object({
    tierId: z.string().optional(),
    status: z.nativeEnum(SubscriptionStatus).optional(),
    stripeSubscriptionId: z.string().optional(),
    stripePriceId: z.string().optional(),
    billingEmail: z.string().email().optional(),
    autoRenew: z.boolean().optional(),
  }),
});

// Types
export type CreateUserInput = z.infer<typeof createUserSchema>["body"];
export type UpdateUserInput = z.infer<typeof updateUserSchema>["body"];
export type GetUserInput = z.infer<typeof getUserSchema>;

export type CreateAgencyMembershipInput = z.infer<
  typeof createAgencyMembershipSchema
>["body"];
export type UpdateAgencyMembershipInput = z.infer<
  typeof updateAgencyMembershipSchema
>["body"];
export type CreateAgencyInvitationInput = z.infer<
  typeof createAgencyInvitationSchema
>["body"];

export type CreateSubscriptionInput = z.infer<
  typeof createSubscriptionSchema
>["body"];
export type UpdateSubscriptionInput = z.infer<
  typeof updateSubscriptionSchema
>["body"];

// Response types
export interface UserResponse {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  timeZone: string | null;
  // Changed to match the actual notification fields in the database
  notificationSettings: {
    productUpdates: boolean;
    reelsReady: boolean;
  };
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subscription: SubscriptionResponse | null;
  // Simplified credits structure based on what can be derived from the database
  credits: {
    balance: number;
    totalAllocated: number;
    totalUsed: number;
  };
}

export interface SubscriptionResponse {
  id: string;
  userId: string;
  tierId: string;
  tierName: string | null;
  status: SubscriptionStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  billingEmail: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  usageRecords: UsageRecordResponse[] | null;
  billingRecords: BillingRecordResponse[] | null;
}

export interface UsageRecordResponse {
  id: string;
  subscriptionId: string;
  resourceType: ResourceType;
  quantity: number;
  recordedAt: Date;
  metadata: Record<string, any> | null;
  createdAt: Date;
}

export interface BillingRecordResponse {
  id: string;
  subscriptionId: string;
  amount: number;
  currency: string;
  status: BillingStatus;
  invoiceId: string | null;
  invoiceUrl: string | null;
  periodStart: Date;
  periodEnd: Date;
  metadata: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResourceAllocationResponse {
  id: string;
  userId: string;
  resourceType: ResourceType;
  totalAllocation: number;
  usedAllocation: number;
  period: AllocationPeriod;
  periodStart: Date;
  periodEnd: Date | null;
  source: string;
  metadata: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCreditResponse {
  balance: number;
  totalAllocated: number;
  totalUsed: number;
  transactions: CreditTransactionResponse[];
}

export interface CreditTransactionResponse {
  id: string;
  userId: string;
  amount: number;
  type: string;
  source: string;
  reason: string;
  metadata: Record<string, any> | null;
  createdAt: Date;
}

export interface AgencyMembershipResponse {
  id: string;
  agencyId: string;
  userId: string;
  role: AgencyRole;
  status: MembershipStatus;
  invitationId: string | null;
  metadata: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
  agency: AgencyResponse | null;
  user: UserResponse | null;
}

export interface AgencyInvitationResponse {
  id: string;
  email: string;
  agencyId: string;
  role: AgencyRole;
  status: InvitationStatus;
  expiresAt: Date;
  token: string;
  metadata: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  agency: AgencyResponse | null;
}

export interface AgencyResponse {
  id: string;
  name: string;
  ownerId: string;
  notificationSettings: Record<string, boolean> | null;
  createdAt: Date;
  updatedAt: Date;
  owner: UserResponse | null;
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
