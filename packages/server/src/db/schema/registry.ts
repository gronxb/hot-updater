import { hotUpdaterSchemaVersions } from "../../schema";
import type {
  HotUpdaterColumnSchema,
  HotUpdaterIndexSchema,
  HotUpdaterTableSchema,
  HotUpdaterVersionedSchema,
} from "../../schema/types";
import type { ORMProvider } from "../types";

export { hotUpdaterSchemaVersions } from "../../schema";

export const hotUpdaterSchema =
  hotUpdaterSchemaVersions[hotUpdaterSchemaVersions.length - 1]!;

export const getSchemaVersionIndex = (version: string): number =>
  hotUpdaterSchemaVersions.findIndex((schema) => schema.version === version);

export const getHotUpdaterSchemaVersion = (
  version: string,
): HotUpdaterVersionedSchema => {
  const schema = hotUpdaterSchemaVersions.find(
    (item) => item.version === version,
  );
  if (!schema)
    throw new Error(`Unsupported Hot Updater schema version: ${version}`);
  return schema;
};

export const getSchemaTable = (name: string): HotUpdaterTableSchema => {
  const table = hotUpdaterSchema.tables.find((item) => item.ormName === name);
  if (!table) throw new Error(`Unknown Hot Updater schema table: ${name}`);
  return table;
};

export const getSchemaColumn = (
  table: HotUpdaterTableSchema,
  name: string,
): HotUpdaterColumnSchema => {
  const column = table.columns.find((item) => item.ormName === name);
  if (!column) {
    throw new Error(
      `Unknown Hot Updater schema column: ${table.ormName}.${name}`,
    );
  }
  return column;
};

export const hotUpdaterDataTables = hotUpdaterSchema.tables.filter(
  (table) => !table.internal,
);

export const schemaIndexAppliesToProvider = (
  index: HotUpdaterIndexSchema,
  provider: ORMProvider,
): boolean => !index.providers || index.providers.includes(provider);
