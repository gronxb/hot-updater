import { PGlite } from "@electric-sql/pglite";
import {
  builtInSettings,
  createTableStatements,
  SETTINGS_TABLE,
} from "@hot-updater/server/database";
import { settingsStatements } from "@hot-updater/server/db";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
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
      [
        ...createTableStatements("postgresql", [...tables, SETTINGS_TABLE]),
        ...settingsStatements("postgresql", builtInSettings),
      ].join(";\n"),
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
