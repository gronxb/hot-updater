import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterTableSchema,
  HotUpdaterVersionedSchema,
} from "../../schema/types";
import { v0_31_0 } from "../../schema/v0_31_0";
import { v0_36_0 } from "../../schema/v0_36_0";

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

const createSpecialMigrationWithDrift = async (
  change: SchemaChange,
): Promise<() => readonly string[]> => {
  const next = change(v0_36_0);
  vi.resetModules();
  vi.doMock("../../schema", () => ({
    hotUpdaterSchemaVersions: [v0_31_0, next],
  }));
  const { createSchemaMigrationSql } = await import("./sqlMigrations");

  return () => createSchemaMigrationSql("0.31.0", "0.36.0", "postgresql");
};

afterEach(() => {
  vi.doUnmock("../../schema");
  vi.resetModules();
});

describe("0.31.0 to 0.36.0 SQL migration drift validation", () => {
  it.each([
    {
      name: "changed existing bundle patch column metadata",
      location: "bundle_patches.id",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          columns: table.columns.map((column) =>
            column.ormName === "id" ? { ...column, nullable: true } : column,
          ),
        })),
    },
    {
      name: "deleted existing bundle patch column",
      location: "bundle_patches.id",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          columns: table.columns.filter((column) => column.ormName !== "id"),
        })),
    },
    {
      name: "changed existing bundle patch index metadata",
      location: "bundle_patches.indexes.bundle_patches_bundle_id_idx",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          indexes: table.indexes?.map((index) =>
            index.name === "bundle_patches_bundle_id_idx"
              ? { ...index, unique: true }
              : index,
          ),
        })),
    },
    {
      name: "deleted existing bundle patch index",
      location: "bundle_patches.indexes.bundle_patches_bundle_id_idx",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          indexes: table.indexes?.filter(
            (index) => index.name !== "bundle_patches_bundle_id_idx",
          ),
        })),
    },
    {
      name: "changed existing bundle check metadata",
      location: "bundles.checks.check_version_or_fingerprint",
      change: (schema) =>
        changeTable(schema, "bundles", (table) => ({
          ...table,
          checks: table.checks?.map((check) =>
            check.name === "check_version_or_fingerprint"
              ? { ...check, expression: "target_app_version is not null" }
              : check,
          ),
        })),
    },
    {
      name: "deleted existing bundle check",
      location: "bundles.checks.check_version_or_fingerprint",
      change: (schema) =>
        changeTable(schema, "bundles", (table) => ({
          ...table,
          checks: table.checks?.filter(
            (check) => check.name !== "check_version_or_fingerprint",
          ),
        })),
    },
    {
      name: "changed existing bundle patch foreign key metadata",
      location: "bundle_patches.foreignKeys.bundle_patches_bundle_id_fk",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          foreignKeys: table.foreignKeys?.map((foreignKey) =>
            foreignKey.name === "bundle_patches_bundle_id_fk"
              ? { ...foreignKey, onDelete: "restrict" }
              : foreignKey,
          ),
        })),
    },
    {
      name: "deleted existing bundle patch foreign key",
      location: "bundle_patches.foreignKeys.bundle_patches_bundle_id_fk",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          foreignKeys: table.foreignKeys?.filter(
            (foreignKey) => foreignKey.name !== "bundle_patches_bundle_id_fk",
          ),
        })),
    },
    {
      name: "unallowlisted column addition",
      location: "bundle_patches.columns.unexpected",
      change: (schema) =>
        changeTable(schema, "bundle_patches", (table) => ({
          ...table,
          columns: [
            ...table.columns,
            { ormName: "unexpected", type: "string" },
          ],
        })),
    },
    {
      name: "unallowlisted table addition",
      location: "unexpected",
      change: (schema) => ({
        ...schema,
        tables: [
          ...schema.tables,
          { ormName: "unexpected", columns: [{ ormName: "id", type: "uuid" }] },
        ],
      }),
    },
    {
      name: "existing table deletion",
      location: "bundle_patches",
      change: (schema) => ({
        ...schema,
        tables: schema.tables.filter(
          (table) => table.ormName !== "bundle_patches",
        ),
      }),
    },
  ] satisfies readonly {
    readonly name: string;
    readonly location: string;
    readonly change: SchemaChange;
  }[])("rejects $name before generating SQL", async ({ change, location }) => {
    // Given
    const migrate = await createSpecialMigrationWithDrift(change);

    // When / Then
    expect(migrate).toThrowError(location);
  });
});
