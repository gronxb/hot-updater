import {
  builtInSettings,
  createTableStatements,
  isMultiIndex,
  type PhysicalTable,
  SETTINGS_TABLE,
  WRITE_GUARD_TABLE,
} from "@hot-updater/server/database";
import { settingsStatements } from "@hot-updater/server/db";
import { env } from "cloudflare:test";

// Not the package index: it loads Node-only helpers workerd lacks.
import { setupDatabaseAdapterConformanceSuite } from "../../../../packages/test-utils/src/setupDatabaseAdapterConformanceSuite";
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
    await env.DB.batch(
      [
        ...createTableStatements("sqlite", created),
        ...settingsStatements("sqlite", builtInSettings),
      ].map((sql) => env.DB.prepare(sql)),
    );
    return {
      adapter: d1Database(env.DB).adapter,
      cleanup: () => drop(created),
    };
  },
});
