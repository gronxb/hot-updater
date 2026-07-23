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

export const assertSupportedSchemaVersion = (
  currentVersion: string | undefined,
): void => {
  if (
    currentVersion !== undefined &&
    currentVersion !== "0.21.0" &&
    currentVersion !== "0.29.0" &&
    currentVersion !== "0.31.0" &&
    currentVersion !== "0.36.0" &&
    currentVersion !== "0.37.0"
  ) {
    throw new Error(
      `Unsupported Hot Updater schema version: ${currentVersion}`,
    );
  }
};

export const isCurrentSchemaVersion = (
  currentVersion: string | undefined,
): boolean => currentVersion === HOT_UPDATER_SCHEMA_VERSION;
