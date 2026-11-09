import { PGlite } from "@electric-sql/pglite";
import {
  coreSettings,
  createSqlAdapter,
  createTableStatements,
  SETTINGS_TABLE,
  WRITE_GUARD_TABLE,
  writeSchemaSettings,
} from "@hot-updater/plugin-core";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { pgliteExecutor } from "@hot-updater/test-utils/node";
import { vi } from "vitest";

import { neonDatabase } from "./neonDatabase";

const state = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

vi.mock("@neondatabase/serverless", async () => {
  const { pgliteNeon } = await import("./neonDriver.testFixtures");
  return { neon: () => pgliteNeon(state.db!) };
});

/**
 * The adapter `neonDatabase` returns, schema fence included: reads are
 * single queries and writes are batches in one non-interactive transaction,
 * through Neon's HTTP driver on a new PGlite per test that holds the
 * conformance tables, the write guard, and the settings rows the fence
 * checks.
 */
setupDatabaseAdapterConformanceSuite({
  name: "neon HTTP (PGlite)",
  // The SQL core's default cap: a batch write takes 1,000 ops.
  maxOps: 1000,
  createAdapter: async ({ tables }) => {
    const db = new PGlite();
    await db.exec(
      createTableStatements("postgresql", [
        ...tables,
        SETTINGS_TABLE,
        WRITE_GUARD_TABLE,
      ]).join(";\n"),
    );
    await writeSchemaSettings(
      createSqlAdapter({ executor: pgliteExecutor(db) }),
      "pglite",
      coreSettings,
    );
    state.db = db;
    return {
      adapter: neonDatabase({
        connectionString: "postgresql://user:password@ep-test.neon.tech/db",
      }).adapter,
      cleanup: async () => {
        state.db = undefined;
        await db.close();
      },
    };
  },
});
