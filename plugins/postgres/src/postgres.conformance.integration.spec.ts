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
import { PGliteDialect } from "kysely-pglite-dialect";

import { postgres } from "./postgres";

/**
 * The adapter `postgres` returns, schema fence included, over a PGlite
 * Kysely dialect on a new PGlite per test that holds the conformance tables
 * and the settings rows the fence checks. PostgreSQL has no cap on one write
 * and no native pages.
 */
setupDatabaseAdapterConformanceSuite({
  name: "postgres (PGlite)",
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
    const database = postgres({ dialect: new PGliteDialect(client) });
    return {
      adapter: database.adapter,
      cleanup: async () => {
        await database.dispose?.();
        await client.close();
      },
    };
  },
});
