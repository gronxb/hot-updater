import {
  coreSettings,
  createTableStatements,
  isMultiIndex,
  type PhysicalTable,
  WRITE_GUARD_TABLE,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
// Not the package index: it loads Node-only helpers workerd lacks.
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";

import { D1_MAX_OPS } from "../../src/d1Executor";
import { d1Database } from "../../src/worker";

/** Drops the tables and their index tables from the D1 binding. */
const drop = async (tables: readonly PhysicalTable[]) => {
  await env.DB.batch(
    tables
      .flatMap((table) => [
        table.name,
        ...table.indexes
          .filter((index) => isMultiIndex(table, index))
          .map((index) => `${table.name}__${index.name}`),
      ])
      .map((name) => env.DB.prepare(`DROP TABLE IF EXISTS "${name}"`)),
  );
};

/**
 * The adapter the worker's `d1Database` returns on the D1 binding, schema
 * fence included: each test creates the conformance tables, the batch guard,
 * and the settings rows the fence checks, and drops them after. D1 has no
 * native pages.
 */
setupDatabaseAdapterConformanceSuite({
  name: "d1 (workerd)",
  maxOps: D1_MAX_OPS,
  createAdapter: async ({ tables }) => {
    const created = [...tables, SETTINGS_TABLE, WRITE_GUARD_TABLE];
    await env.DB.batch([
      ...createTableStatements("sqlite", created).map((sql) =>
        env.DB.prepare(sql),
      ),
      ...Object.entries(coreSettings).map(([key, value]) =>
        env.DB.prepare(
          `INSERT INTO "${SETTINGS_TABLE.name}" ("key", "value", "_v") VALUES (?, ?, 0)`,
        ).bind(key, value),
      ),
    ]);
    return {
      adapter: d1Database(env.DB).adapter,
      cleanup: () => drop(created),
    };
  },
});
