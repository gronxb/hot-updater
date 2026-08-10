import type { HotUpdaterPluginSetupContext } from "@hot-updater/server/internal/first-party-plugin";

const unexpectedDatabaseAccess = async (): Promise<never> => {
  throw new Error("Better Auth must not access the database runtime.");
};

export const createPluginSetupContext = (): HotUpdaterPluginSetupContext => ({
  capabilities: {
    get: () => undefined,
    require() {
      throw new Error("No capabilities are required.");
    },
  },
  components: {
    get: () => undefined,
    require() {
      throw new Error("No components are required.");
    },
  },
  database: Object.freeze({
    count: unexpectedDatabaseAccess,
    create: unexpectedDatabaseAccess,
    delete: unexpectedDatabaseAccess,
    findMany: unexpectedDatabaseAccess,
    findOne: unexpectedDatabaseAccess,
    name: "better-auth-test",
    update: unexpectedDatabaseAccess,
  }),
});
