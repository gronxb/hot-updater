import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
import { PrismaClient } from "@prisma/client";

const database = prismaAdapter({
  prisma: new PrismaClient(),
  provider: "postgresql",
});

export const publicServer = createHotUpdater({
  database,
  clientAccess: { type: "public" },
});

export const privateServer = createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
});
