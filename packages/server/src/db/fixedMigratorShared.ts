import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
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

export const assertCurrentOrEmptySchemaVersion = (
  currentVersion: string | undefined,
): void => {
  if (
    currentVersion !== undefined &&
    currentVersion !== HOT_UPDATER_SCHEMA_VERSION
  ) {
    throw new Error(unsupportedSchemaUpgradeMessage(currentVersion));
  }
};

export const inferLegacyCoreSchemaVersion = (
  legacyVersion: string | undefined,
): string | undefined => legacyVersion;

export const isCurrentSchemaVersion = (
  currentVersion: string | undefined,
): boolean => currentVersion === HOT_UPDATER_SCHEMA_VERSION;
