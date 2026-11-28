import type {
  DatabaseAdapter,
  PhysicalTable,
  WriteOp,
} from "../../database/adapter";
import { LATE_COLUMNS, LATE_INDEXES } from "../core/schema";
import {
  readSettings,
  SETTINGS_TABLE,
  type SchemaSettings,
} from "../database/fence";
import { refuseNewerSchema } from "./settingsMigrator";

const storedSettings = async (
  adapter: DatabaseAdapter,
  keys: readonly string[],
) => {
  const rows = await readSettings(adapter, keys);
  return new Map(keys.map((key, position) => [key, rows[position] ?? null]));
};

/**
 * Writes the settings rows after every table exists, and refuses a database
 * whose `ordered` settings a newer release recorded.
 */
export const writeSchemaSettings = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  settings: SchemaSettings,
  ordered?: readonly string[],
): Promise<void> => {
  const stored = await storedSettings(adapter, Object.keys(settings));
  refuseNewerSchema(
    adapterName,
    new Map([...stored].map(([key, row]) => [key, row?.value])),
    settings,
    ordered,
  );
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
      `${adapterName}: the schema settings changed during the migration; run it again.`,
    );
  }
};

/**
 * The `LATE_INDEXES` among `tables` whose items some rows lack, as
 * `<table>.<index>`, written unless `dryRun`: none on a store without
 * `migrations.fillIndex`.
 */
export const fillLateIndexes = async (
  adapter: DatabaseAdapter,
  tables: readonly PhysicalTable[],
  { dryRun = false }: { readonly dryRun?: boolean } = {},
): Promise<string[]> => {
  const fillIndex = adapter.migrations?.fillIndex;
  if (fillIndex === undefined) return [];
  const lacking: string[] = [];
  for (const { table: name, index } of LATE_INDEXES) {
    const table = tables.find((candidate) => candidate.name === name);
    if (table === undefined) continue;
    const rows = await fillIndex(table, index, { dryRun });
    if (rows > 0) lacking.push(`${name}.${index}`);
  }
  return lacking;
};

/**
 * The `LATE_COLUMNS` among `tables` that an existing table lacks, as
 * `<table>.<column>`, added unless `dryRun`: none on a store without
 * `migrations.addColumns`, or for a table not created yet.
 */
export const addLateColumns = async (
  adapter: DatabaseAdapter,
  tables: readonly PhysicalTable[],
  { dryRun = false }: { readonly dryRun?: boolean } = {},
): Promise<string[]> => {
  const addColumns = adapter.migrations?.addColumns;
  if (addColumns === undefined) return [];
  const lacking: string[] = [];
  for (const table of tables) {
    const columns = LATE_COLUMNS.filter(
      ({ table: name }) => name === table.name,
    ).map(({ column }) => column);
    if (columns.length === 0) continue;
    const added = await addColumns(table, columns, { dryRun });
    lacking.push(...added.map((column) => `${table.name}.${column}`));
  }
  return lacking;
};

/**
 * Adds the late columns existing tables lack, creates or updates every
 * table, writes the late indexes' missing items, then writes the settings
 * rows last. A database a newer release migrated is
 * refused before anything is written: its settings are read first, and a
 * store without them yet, whose read fails, has none to refuse.
 */
export const migrateSchema = async (
  adapter: DatabaseAdapter,
  adapterName: string,
  tables: readonly PhysicalTable[],
  settings: SchemaSettings,
  ordered?: readonly string[],
): Promise<void> => {
  if (adapter.migrations === undefined) {
    throw new Error(
      `${adapterName} creates its tables with its own tooling; write only the settings rows.`,
    );
  }
  const stored = await storedSettings(adapter, Object.keys(settings)).catch(
    () => undefined,
  );
  if (stored !== undefined) {
    refuseNewerSchema(
      adapterName,
      new Map([...stored].map(([key, row]) => [key, row?.value])),
      settings,
      ordered,
    );
  }
  await addLateColumns(adapter, tables);
  await adapter.migrations.apply([...tables, SETTINGS_TABLE]);
  await fillLateIndexes(adapter, tables);
  await writeSchemaSettings(adapter, adapterName, settings, ordered);
};
