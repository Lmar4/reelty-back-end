import { UserRole } from "@prisma/client";

export interface AgencyUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: UserRole;
  agencyId: string;
  agencyOwnerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgencyStats {
  totalUsers: number;
  activeUsers: number;
  totalCredits: number;
  usedCredits: number;
  videoGenerations: number;
}

export interface CreateAgencyInput {
  name: string;
  ownerEmail: string;
  maxUsers: number;
  initialCredits: number;
}

export interface AddAgencyUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
  credits?: number;
}

export interface BulkDiscountInput {
  name: string;
  description: string;
  discountPercent: number;
  maxUsers: number;
  expiresAt?: Date;
}

export interface AgencyUserStats {
  userId: string;
  email: string;
  totalCredits: number;
  usedCredits: number;
  lastActive: Date;
  videoGenerations: number;
}
