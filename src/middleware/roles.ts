import { Request, Response, NextFunction } from "express";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

export const isAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        error: "Unauthorized: Admin access required",
      });
      return;
    }

    next();
  } catch (error) {
    console.error("Admin authorization error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
    return;
  }
};

export const isAgencyOwner = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.user?.role !== UserRole.AGENCY) {
    res.status(403).json({
      success: false,
      error: "Only agency owners can perform this action",
    });
    return;
  }
  next();
};

export const isAgencyUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.AGENCY_USER) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized: Agency user access required",
      });
    }

    next();
  } catch (error) {
    console.error("Agency user authorization error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};

export const hasAgencyAccess = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { role: true },
    });

    if (
      user?.role !== UserRole.AGENCY &&
      user?.role !== UserRole.AGENCY_USER &&
      user?.role !== UserRole.ADMIN
    ) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized: Agency access required",
      });
    }

    next();
  } catch (error) {
    console.error("Agency access authorization error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};
