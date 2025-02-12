import { PrismaClient, User, UserRole } from "@prisma/client";
import { AgencyInput } from "../types/agency";

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
        agencyMaxUsers: data.maxUsers,
        agencyCurrentUsers: 0,
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

    if (agency.role !== UserRole.AGENCY) {
      throw new Error("Specified user is not an agency");
    }

    if ((agency.agencyCurrentUsers || 0) >= (agency.agencyMaxUsers || 0)) {
      throw new Error("Agency has reached maximum number of users");
    }

    // Update user to be part of agency
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        role: UserRole.AGENCY_USER,
        agencyId: agencyId,
      },
    });

    // Increment agency user count
    await this.prisma.user.update({
      where: { id: agencyId },
      data: {
        agencyCurrentUsers: {
          increment: 1,
        },
      },
    });

    return updatedUser;
  }

  async removeUserFromAgency(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        agency: true,
      },
    });

    if (!user || !user.agencyId) {
      throw new Error("User not found or not part of an agency");
    }

    // Update user to remove from agency
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        role: UserRole.USER,
        agencyId: null,
      },
    });

    // Decrement agency user count
    await this.prisma.user.update({
      where: { id: user.agencyId },
      data: {
        agencyCurrentUsers: {
          decrement: 1,
        },
      },
    });

    return updatedUser;
  }
}
