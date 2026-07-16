import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterCheckSchema,
  HotUpdaterColumnSchema,
  HotUpdaterForeignKeySchema,
  HotUpdaterIndexSchema,
  HotUpdaterVersionedSchema,
} from "../../schema/types";

type MutableTableSchema = {
  ormName: string;
  columns: HotUpdaterColumnSchema[];
  indexes: HotUpdaterIndexSchema[];
  checks: HotUpdaterCheckSchema[];
  foreignKeys: HotUpdaterForeignKeySchema[];
};

const createSchemaVersions = (): {
  readonly versions: readonly HotUpdaterVersionedSchema[];
  readonly nextTable: MutableTableSchema;
} => {
  const createTable = (): MutableTableSchema => ({
    ormName: "records",
    columns: [{ ormName: "id", type: "uuid", primaryKey: true }],
    indexes: [
      {
        name: "records_id_idx",
        columns: ["id"],
        providers: ["postgresql"],
      },
    ],
    checks: [{ name: "records_id_check", expression: "id is not null" }],
    foreignKeys: [
      {
        name: "records_parent_fk",
        columns: ["id"],
        referencedTable: "parents",
        referencedColumns: ["id"],
        onUpdate: "restrict",
        onDelete: "cascade",
      },
    ],
  });
  const previousTable = createTable();
  const nextTable = createTable();

  return {
    versions: [
      {
        version: "0.21.0",
        settingsTable: "private_hot_updater_settings",
        tables: [previousTable],
      },
      {
        version: "0.29.0",
        settingsTable: "private_hot_updater_settings",
        tables: [nextTable],
      },
    ],
    nextTable,
  };
};

const createMigrationWithDrift = async (
  change: (table: MutableTableSchema) => void,
): Promise<() => readonly string[]> => {
  const { versions, nextTable } = createSchemaVersions();
  change(nextTable);
  vi.resetModules();
  vi.doMock("../../schema", () => ({ hotUpdaterSchemaVersions: versions }));
  const { createSchemaMigrationSql } = await import("./sqlMigrations");

  return () => createSchemaMigrationSql("0.21.0", "0.29.0", "postgresql");
};

afterEach(() => {
  vi.doUnmock("../../schema");
  vi.resetModules();
});

describe("createSchemaMigrationSql schema drift validation", () => {
  it.each([
    {
      name: "changed column metadata",
      change: (table: MutableTableSchema) => {
        table.columns[0] = {
          ormName: "id",
          type: "uuid",
          primaryKey: true,
          nullable: true,
        };
      },
      location: "records.id",
    },
    {
      name: "deleted column",
      change: (table: MutableTableSchema) => {
        table.columns = [];
      },
      location: "records.id",
    },
    {
      name: "changed provider-applicable index metadata",
      change: (table: MutableTableSchema) => {
        table.indexes[0] = {
          name: "records_id_idx",
          columns: ["id", "other_id"],
          providers: ["postgresql"],
        };
      },
      location: "records.indexes.records_id_idx",
    },
    {
      name: "deleted provider-applicable index",
      change: (table: MutableTableSchema) => {
        table.indexes = [];
      },
      location: "records.indexes.records_id_idx",
    },
    {
      name: "changed check metadata",
      change: (table: MutableTableSchema) => {
        table.checks[0] = {
          name: "records_id_check",
          expression: "id is null",
        };
      },
      location: "records.checks.records_id_check",
    },
    {
      name: "deleted check",
      change: (table: MutableTableSchema) => {
        table.checks = [];
      },
      location: "records.checks.records_id_check",
    },
    {
      name: "changed foreign-key metadata",
      change: (table: MutableTableSchema) => {
        table.foreignKeys[0] = {
          name: "records_parent_fk",
          columns: ["id"],
          referencedTable: "parents",
          referencedColumns: ["id"],
          onUpdate: "restrict",
          onDelete: "restrict",
        };
      },
      location: "records.foreignKeys.records_parent_fk",
    },
    {
      name: "deleted foreign key",
      change: (table: MutableTableSchema) => {
        table.foreignKeys = [];
      },
      location: "records.foreignKeys.records_parent_fk",
    },
  ])("rejects $name", async ({ change, location }) => {
    // Given
    const migrate = await createMigrationWithDrift(change);

    // When / Then
    expect(migrate).toThrowError(location);
  });
});
