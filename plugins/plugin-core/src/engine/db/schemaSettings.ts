import type {
  DatabaseAdapter,
  PhysicalTable,
  WriteOp,
} from "../../database/adapter";
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
 * Creates or updates every table, then writes the settings rows last. A
 * database a newer release migrated is refused before anything is written:
 * its settings are read first, and a store without them yet, whose read
 * fails, has none to refuse.
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
  await adapter.migrations.apply([...tables, SETTINGS_TABLE]);
  await writeSchemaSettings(adapter, adapterName, settings, ordered);
};
