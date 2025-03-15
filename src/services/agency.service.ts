import { PrismaClient, User, UserRole } from "@prisma/client";
import { AgencyInput } from "../types/agency.js";

export class AgencyService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  async getAgencies(): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        role: UserRole.AGENCY,
      },
      include: {
        agencyUsers: true,
      },
    });
  }

  async createAgency(data: AgencyInput): Promise<User> {
    // Create agency account
    const agency = await this.prisma.user.update({
      where: { id: data.ownerId },
      data: {
        role: UserRole.AGENCY,
        agencyName: data.name,
      },
    });

    return agency;
  }

  async addUserToAgency(agencyId: string, userId: string): Promise<User> {
    // Get agency first
    const agency = await this.prisma.user.findUnique({
      where: { id: agencyId },
      include: {
        agencyUsers: true,
      },
    });

    if (!agency) {
      throw new Error("Agency not found");
    }

    // Check if agency has reached max users
    // Use a constant or configuration value for max users
    const MAX_AGENCY_USERS = 10;
    if (agency.agencyUsers.length >= MAX_AGENCY_USERS) {
      throw new Error("Agency has reached maximum number of users");
    }

    // Check if user is already in agency
    const isUserInAgency = agency.agencyUsers.some(
      (user) => user.id === userId
    );

    if (isUserInAgency) {
      throw new Error("User is already in agency");
    }

    // Add user to agency
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        agencyId,
      },
    });

    return user;
  }

  async removeUserFromAgency(userId: string): Promise<User> {
    // Get user first
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        agency: true,
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    if (!user.agencyId) {
      throw new Error("User is not part of an agency");
    }

    // Update user to remove from agency
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        agencyId: null,
      },
    });

    return updatedUser;
  }
}
