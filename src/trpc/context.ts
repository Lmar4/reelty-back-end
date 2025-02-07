import { PrismaClient } from "@prisma/client";
import { inferAsyncReturnType } from "@trpc/server";
import * as trpcNext from "@trpc/server/adapters/next";

const prisma = new PrismaClient();

interface AuthContext {
  userId: string;
  sessionId: string;
}

interface CreateInnerContextOptions
  extends Partial<trpcNext.CreateNextContextOptions> {
  auth?: AuthContext;
}

export async function createInnerContext(opts: CreateInnerContextOptions) {
  return {
    prisma,
    auth: opts.auth,
    req: opts.req,
  };
}

export const createContext = async (
  opts: trpcNext.CreateNextContextOptions
) => {
  const innerContext = await createInnerContext(opts);

  return {
    ...innerContext,
  };
};

export type Context = inferAsyncReturnType<typeof createContext>;
