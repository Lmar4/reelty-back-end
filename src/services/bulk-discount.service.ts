import { PrismaClient } from "@prisma/client";
import { BulkDiscountInput } from "../types/agency";

const prisma = new PrismaClient();

export class BulkDiscountService {
  async createBulkDiscount(input: BulkDiscountInput) {
    return await prisma.bulkDiscount.create({
      data: {
        name: input.name,
        description: input.description,
        discountPercent: input.discountPercent,
        maxUsers: input.maxUsers,
        expiresAt: input.expiresAt,
      },
    });
  }

  async getBulkDiscounts() {
    return await prisma.bulkDiscount.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async applyBulkDiscount(discountId: string, userId: string) {
    const discount = await prisma.bulkDiscount.findUnique({
      where: { id: discountId },
    });

    if (!discount) {
      throw new Error("Discount not found");
    }

    if (!discount.isActive) {
      throw new Error("Discount is no longer active");
    }

    if (discount.currentUsers >= discount.maxUsers) {
      throw new Error("Discount limit reached");
    }

    if (discount.expiresAt && discount.expiresAt < new Date()) {
      throw new Error("Discount has expired");
    }

    return await prisma.$transaction(async (tx) => {
      // Update user with discount
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          bulkDiscountId: discountId,
        },
      });

      // Increment discount usage
      await tx.bulkDiscount.update({
        where: { id: discountId },
        data: {
          currentUsers: {
            increment: 1,
          },
        },
      });

      // If max users reached, deactivate discount
      if (discount.currentUsers + 1 >= discount.maxUsers) {
        await tx.bulkDiscount.update({
          where: { id: discountId },
          data: {
            isActive: false,
          },
        });
      }

      return updatedUser;
    });
  }

  async deactivateDiscount(discountId: string) {
    return await prisma.bulkDiscount.update({
      where: { id: discountId },
      data: {
        isActive: false,
      },
    });
  }

  async getDiscountStats(discountId: string) {
    const [discount, users] = await Promise.all([
      prisma.bulkDiscount.findUnique({
        where: { id: discountId },
      }),
      prisma.user.findMany({
        where: {
          bulkDiscountId: discountId,
        },
        select: {
          id: true,
          email: true,
          createdAt: true,
        },
      }),
    ]);

    if (!discount) {
      throw new Error("Discount not found");
    }

    return {
      discount,
      usersCount: users.length,
      remainingSlots: discount.maxUsers - discount.currentUsers,
      isActive: discount.isActive,
      users,
    };
  }
}
