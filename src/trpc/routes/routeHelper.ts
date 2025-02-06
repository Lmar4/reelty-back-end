import { getTRPC } from "../types";

// Initialize tRPC for routes
let tRPCInstance: Awaited<ReturnType<typeof getTRPC>> | null = null;

export const getRouteUtils = async () => {
  if (!tRPCInstance) {
    tRPCInstance = await getTRPC();
  }
  return tRPCInstance;
};
