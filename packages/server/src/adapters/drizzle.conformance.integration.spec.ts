import { PGlite } from "@electric-sql/pglite";
import {
  coreSettings,
  createSqlAdapter,
  createTableStatements,
  SETTINGS_TABLE,
  writeSchemaSettings,
} from "@hot-updater/plugin-core";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { pgliteExecutor } from "@hot-updater/test-utils/node";
import { drizzle } from "drizzle-orm/pglite";

import { drizzleAdapter } from "./drizzle";

/**
 * The adapter `drizzleAdapter` returns, schema fence included, over Drizzle's
 * PGlite driver on a new PGlite per test. drizzle-kit has no schema for the
 * conformance tables, so the SQL core's DDL creates them, beside the settings
 * rows the fence checks. PostgreSQL has no cap on one write and no native
 * pages.
 */
setupDatabaseAdapterConformanceSuite({
  name: "drizzle (PGlite)",
  createAdapter: async ({ tables }) => {
    const client = new PGlite();
    await client.exec(
      createTableStatements("postgresql", [...tables, SETTINGS_TABLE]).join(
        ";\n",
      ),
    );
    await writeSchemaSettings(
      createSqlAdapter({ executor: pgliteExecutor(client) }),
      "pglite",
      coreSettings,
    );
    return {
      adapter: drizzleAdapter({ db: drizzle(client), provider: "postgresql" })
        .adapter,
      cleanup: () => client.close(),
    };
  },
});
