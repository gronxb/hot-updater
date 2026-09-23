import type {
  DatabaseAdapter,
  PhysicalTable,
  StoredRow,
  WriteOp,
} from "@hot-updater/plugin-core/internal";

import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";

/** The settings rows migrations write, last, and the fence reads. */
export const SETTINGS_TABLE: PhysicalTable = {
  name: "private_hot_updater_settings",
  columns: [
    { name: "key", type: "string", nullable: false, maxLength: 255 },
    { name: "value", type: "string", nullable: false, maxLength: 255 },
    { name: "_v", type: "integer", nullable: false, default: 0 },
  ],
  key: ["key"],
  indexes: [],
};

/** The engine's storage-layout generation; it changes only with a migration. */
export const ENGINE_SCHEMA_KEY = "schema.engine";
export const ENGINE_SCHEMA_VERSION = "1";

/** Settings keys and the values a process expects, `schema.engine` included. */
export type SchemaSettings = Readonly<Record<string, string>>;

const readSettings = async (
  adapter: DatabaseAdapter,
  keys: readonly string[],
): Promise<readonly (StoredRow | null)[]> =>
  adapter.get(
    SETTINGS_TABLE,
    keys.map((key) => [key]),
  );

/** Throws unless every expected setting is stored with its value: one batch read. */
export const checkSchemaFence = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  expected: SchemaSettings,
): Promise<void> => {
  const keys = Object.keys(expected);
  let rows: readonly (StoredRow | null)[];
  try {
    rows = await readSettings(adapter, keys);
  } catch (cause) {
    throw new HotUpdaterSchemaMigrationRequiredError(
      adapterName,
      undefined,
      { key: ENGINE_SCHEMA_KEY, expected: ENGINE_SCHEMA_VERSION, found: null },
      { cause },
    );
  }
  keys.forEach((key, position) => {
    const found = rows[position]?.value;
    if (found !== expected[key]) {
      throw new HotUpdaterSchemaMigrationRequiredError(adapterName, undefined, {
        key,
        expected: expected[key]!,
        found: typeof found === "string" ? found : null,
      });
    }
  });
};

/**
 * The adapter behind the schema fence: a process's first read or write
 * checks the settings first. Success is kept; a failure is checked again on
 * the next call.
 */
export const withSchemaFence = (
  adapter: DatabaseAdapter,
  adapterName: string,
  expected: SchemaSettings,
): DatabaseAdapter => {
  let ready: Promise<void> | undefined;
  const fence = () => {
    ready ??= checkSchemaFence(adapter, adapterName, expected).catch(
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    return ready;
  };
  return {
    ...adapter,
    get: async (table, keys) => {
      await fence();
      return adapter.get(table, keys);
    },
    query: async (table, request) => {
      await fence();
      return adapter.query(table, request);
    },
    write: async (ops) => {
      await fence();
      return adapter.write(ops);
    },
  };
};

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
  ]).catch(() => new Map<string, StoredRow | null>());
  assertEngineDatabase(adapterName, stored);
  await adapter.migrations.apply([...tables, SETTINGS_TABLE]);
  await writeSchemaSettings(adapter, adapterName, settings);
};
