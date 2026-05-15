import { prismaAdapter as fumadbPrismaAdapter } from "fumadb/adapters/prisma";

import type { ORMDatabaseAdapter } from "../db/types";

export type PrismaConfig = Parameters<typeof fumadbPrismaAdapter>[0];

export const prismaAdapter = (config: PrismaConfig): ORMDatabaseAdapter =>
  Object.assign(
    fumadbPrismaAdapter(
      config as unknown as Parameters<typeof fumadbPrismaAdapter>[0],
    ) as unknown as ORMDatabaseAdapter,
    {
      provider: config.provider,
    },
  );
