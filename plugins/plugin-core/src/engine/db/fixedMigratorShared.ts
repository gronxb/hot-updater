import type { MigrationResult } from "./types";

export const getEmptyMigrationResult = (): MigrationResult => ({
  operations: [],
  execute: async () => {},
  getSQL: () => "",
});
