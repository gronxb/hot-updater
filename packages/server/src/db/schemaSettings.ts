import type {
  DatabaseAdapter,
  PhysicalTable,
  StoredRow,
  WriteOp,
} from "@hot-updater/plugin-core/internal";

import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  HotUpdaterSchemaMigrationRequiredError,
  isMissingSchemaError,
  readSettings,
  SETTINGS_TABLE,
  type SchemaSettings,
} from "../database/fence";

/** Refuses a database with `schema.core` but no `schema.engine`: it predates the engine. */
const assertEngineDatabase = (
  adapterName: string,
  stored: ReadonlyMap<string, StoredRow | null>,
) => {
  if (stored.get("schema.core") && !stored.get(ENGINE_SCHEMA_KEY)) {
    throw new HotUpdaterSchemaMigrationRequiredError(
      adapterName,
      String(stored.get("schema.core")!.value),
      { key: ENGINE_SCHEMA_KEY, expected: ENGINE_SCHEMA_VERSION, found: null },
    );
  }
};

const storedSettings = async (
  adapter: DatabaseAdapter,
  keys: readonly string[],
) => {
  const rows = await readSettings(adapter, keys);
  return new Map(keys.map((key, position) => [key, rows[position] ?? null]));
};

/** Writes the settings rows after every table exists, refusing a pre-engine database. */
export const writeSchemaSettings = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  settings: SchemaSettings,
): Promise<void> => {
  const stored = await storedSettings(adapter, [
    ...new Set(["schema.core", ENGINE_SCHEMA_KEY, ...Object.keys(settings)]),
  ]);
  assertEngineDatabase(adapterName, stored);
  const ops = Object.entries(settings).flatMap(([key, value]): WriteOp[] => {
    const row = stored.get(key);
    if (row === null || row === undefined) {
      return [
        { type: "insert", table: SETTINGS_TABLE, row: { key, value, _v: 0 } },
      ];
    }
    if (row.value === value) return [];
    return [
      {
        type: "patch",
        table: SETTINGS_TABLE,
        key: [key],
        set: { value },
        guard: { v: Number(row._v) },
        previous: row,
      },
    ];
  });
  if (ops.length === 0) return;
  const result = await adapter.write(ops);
  if (!result.ok) {
    throw new Error(
      "The schema settings changed during the migration; run it again.",
    );
  }
};

/**
 * Creates or updates every table, then writes the settings rows last. A
 * pre-engine database is refused before any table changes.
 */
export const migrateSchema = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  tables: readonly PhysicalTable[],
  settings: SchemaSettings,
): Promise<void> => {
  if (adapter.migrations === undefined) {
    throw new Error(
      `${adapterName} creates its tables with its own tooling; write only the settings rows.`,
    );
  }
  // A database without the settings table is empty, so nothing is refused.
  const stored = await storedSettings(adapter, [
    "schema.core",
    ENGINE_SCHEMA_KEY,
  ]).catch((error: unknown) => {
    if (!isMissingSchemaError(error)) throw error;
    return new Map<string, StoredRow | null>();
  });
  assertEngineDatabase(adapterName, stored);
  await adapter.migrations.apply([...tables, SETTINGS_TABLE]);
  await writeSchemaSettings(adapter, adapterName, settings);
};
