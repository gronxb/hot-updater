import { hotUpdaterSchemaVersions } from "../../schema";
import type { ORMSQLProvider, RelationMode } from "../types";

export const createV036MigrationSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  const previous = hotUpdaterSchemaVersions.find(
    (schema) => schema.version === "0.31.0",
  );
  const next = hotUpdaterSchemaVersions.find(
    (schema) => schema.version === "0.36.0",
  );
  if (!previous || !next) {
    throw new Error("Hot Updater schema version 0.36.0 is incomplete.");
  }
  void provider;
  void relationMode;
  return [];
};
