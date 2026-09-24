import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { PrismaClient } from "@prisma/client";

const database = prismaAdapter({
  prisma: new PrismaClient(),
  provider: "postgresql",
});

export const publicServer = createHotUpdater({
  database,
  clientAccess: "public",
  plugins: [insights()],
});

export const privateServer = createHotUpdater({
  database,
  plugins: [insights(), apiKeys()],
});
