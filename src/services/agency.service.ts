import { PrismaClient, UserRole } from "@prisma/client";
import {
  CreateAgencyInput,
  AddAgencyUserInput,
  AgencyStats,
} from "../types/agency";
import {
  SUBSCRIPTION_TIERS,
  SubscriptionTierId,
  isAgencyTier,
} from "../constants/subscription-tiers";
import crypto from "crypto";

const prisma = new PrismaClient();

export class AgencyService {
  async createAgency(input: CreateAgencyInput) {
    const { name, ownerEmail, maxUsers, initialCredits } = input;

    return await prisma.$transaction(async (tx) => {
      // Create agency owner
      const agencyOwner = await tx.user.create({
        data: {
          id: crypto.randomUUID(),
          email: ownerEmail,
          password: crypto.randomUUID(), // Temporary password that should be changed on first login
          role: UserRole.AGENCY,
          agencyName: name,
          agencyMaxUsers: maxUsers,
          agencyCurrentUsers: 1, // Owner counts as first user
          currentTierId: SUBSCRIPTION_TIERS.AGENCY,
        },
      });

      // Create initial credit allocation
      if (initialCredits > 0) {
        await tx.creditLog.create({
          data: {
            userId: agencyOwner.id,
            amount: initialCredits,
            reason: "Initial agency credits allocation",
          },
        });
      }

      return agencyOwner;
    });
  }

  async addAgencyUser(agencyId: string, input: AddAgencyUserInput) {
    const agency = await prisma.user.findUnique({
      where: { id: agencyId },
      select: {
        id: true,
        agencyCurrentUsers: true,
        agencyMaxUsers: true,
        currentTierId: true,
      },
    });

    if (!agency) {
      throw new Error("Agency not found");
    }

    if (!isAgencyTier(agency.currentTierId as SubscriptionTierId)) {
      throw new Error("Invalid agency subscription");
    }

    if (agency.agencyCurrentUsers! >= agency.agencyMaxUsers!) {
      throw new Error("Agency user limit reached");
    }

    return await prisma.$transaction(async (tx) => {
      // Create agency user
      const agencyUser = await tx.user.create({
        data: {
          id: crypto.randomUUID(),
          email: input.email,
          password: crypto.randomUUID(), // Temporary password that should be changed on first login
          firstName: input.firstName,
          lastName: input.lastName,
          role: UserRole.AGENCY_USER,
          agencyId: agency.id,
          currentTierId: agency.currentTierId,
        },
      });

      // Update agency user count
      await tx.user.update({
        where: { id: agency.id },
        data: {
          agencyCurrentUsers: {
            increment: 1,
          },
        },
      });

      // Allocate credits if specified
      if (input.credits && input.credits > 0) {
        await tx.creditLog.create({
          data: {
            userId: agencyUser.id,
            amount: input.credits,
            reason: "Agency user initial credits allocation",
          },
        });
      }

      return agencyUser;
    });
  }

  async removeAgencyUser(agencyId: string, userId: string) {
    const agencyUser = await prisma.user.findFirst({
      where: {
        id: userId,
        agencyId: agencyId,
        role: UserRole.AGENCY_USER,
      },
    });

    if (!agencyUser) {
      throw new Error("Agency user not found");
    }

    return await prisma.$transaction(async (tx) => {
      // Update user
      await tx.user.update({
        where: { id: userId },
        data: {
          role: UserRole.USER,
          agencyId: null,
          currentTierId: SUBSCRIPTION_TIERS.BASIC,
        },
      });

      // Update agency user count
      await tx.user.update({
        where: { id: agencyId },
        data: {
          agencyCurrentUsers: {
            decrement: 1,
          },
        },
      });
    });
  }

  async getAgencyStats(agencyId: string): Promise<AgencyStats> {
    const [users, credits, videos] = await Promise.all([
      // Get user stats
      prisma.user.aggregate({
        where: {
          OR: [{ id: agencyId }, { agencyId: agencyId }],
        },
        _count: true,
      }),
      // Get credit stats
      prisma.creditLog.aggregate({
        where: {
          OR: [{ userId: agencyId }, { user: { agencyId: agencyId } }],
        },
        _sum: {
          amount: true,
        },
      }),
      // Get video generation stats
      prisma.videoJob.aggregate({
        where: {
          OR: [{ userId: agencyId }, { user: { agencyId: agencyId } }],
        },
        _count: true,
      }),
    ]);

    return {
      totalUsers: users._count,
      activeUsers: users._count, // TODO: Implement active user logic
      totalCredits: credits._sum.amount || 0,
      usedCredits: 0, // TODO: Implement used credits calculation
      videoGenerations: videos._count,
    };
  }
}
