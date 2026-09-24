import { HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import type { MigrateOptions, MigrationResult } from "./types";

export const getEmptyMigrationResult = (): MigrationResult => ({
  operations: [],
  execute: async () => {},
  getSQL: () => "",
});

export const assertSupportedMigrationMode = (options: MigrateOptions): void => {
  if (options.mode === "from-database") {
    throw new Error("Hot Updater migrations support only mode: 'from-schema'.");
  }
};

export const unsupportedSchemaUpgradeMessage = (version: string): string =>
  `Hot Updater v1 cannot migrate schema ${version} in place. Create a new empty database and run migrate or generate against schema ${HOT_UPDATER_SCHEMA_VERSION}.`;
