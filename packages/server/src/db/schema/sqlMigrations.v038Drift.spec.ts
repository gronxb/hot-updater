import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterTableSchema,
  HotUpdaterVersionedSchema,
} from "../../schema/types";
import { v0_37_0 } from "../../schema/v0_37_0";
import { v0_38_0 } from "../../schema/v0_38_0";

type SchemaChange = (
  schema: HotUpdaterVersionedSchema,
) => HotUpdaterVersionedSchema;

const changeTable = (
  schema: HotUpdaterVersionedSchema,
  tableName: string,
  change: (table: HotUpdaterTableSchema) => HotUpdaterTableSchema,
): HotUpdaterVersionedSchema => ({
  ...schema,
  tables: schema.tables.map((table) =>
    table.ormName === tableName ? change(table) : table,
  ),
});

const createMigrationWithDrift = async (
  change: SchemaChange,
): Promise<() => readonly string[]> => {
  const next = change(v0_38_0);
  vi.resetModules();
  vi.doMock("../../schema", () => ({
    hotUpdaterSchemaVersions: [v0_37_0, next],
  }));
  const { createSchemaMigrationSql } = await import("./sqlMigrations");

  return () => createSchemaMigrationSql("0.37.0", "0.38.0", "postgresql");
};

afterEach(() => {
  vi.doUnmock("../../schema");
  vi.resetModules();
});

describe("0.37.0 to 0.38.0 SQL migration drift validation", () => {
  it.each([
    {
      name: "nullable bundle Channel reference",
      location: "bundles.columns",
      change: (schema) =>
        changeTable(schema, "bundles", (table) => ({
          ...table,
          columns: table.columns.map((column) =>
            column.ormName === "channel_id"
              ? { ...column, nullable: true }
              : column,
          ),
        })),
    },
    {
      name: "cascading Channel deletion",
      location: "bundles.foreignKeys",
      change: (schema) =>
        changeTable(schema, "bundles", (table) => ({
          ...table,
          foreignKeys: table.foreignKeys?.map((foreignKey) =>
            foreignKey.name === "bundles_channel_id_fk"
              ? { ...foreignKey, onDelete: "cascade" }
              : foreignKey,
          ),
        })),
    },
    {
      name: "unmigrated event index",
      location: "bundle_events.indexes",
      change: (schema) =>
        changeTable(schema, "bundle_events", (table) => ({
          ...table,
          indexes: [
            ...(table.indexes ?? []),
            { name: "unexpected", columns: ["id"] },
          ],
        })),
    },
    {
      name: "extra table",
      location: "channels",
      change: (schema) => ({
        ...schema,
        tables: [
          ...schema.tables,
          { ormName: "unexpected", columns: [{ ormName: "id", type: "uuid" }] },
        ],
      }),
    },
  ] satisfies readonly {
    readonly name: string;
    readonly location: string;
    readonly change: SchemaChange;
  }[])("rejects $name before generating SQL", async ({ change, location }) => {
    const migrate = await createMigrationWithDrift(change);

    expect(migrate).toThrowError(location);
  });
});
