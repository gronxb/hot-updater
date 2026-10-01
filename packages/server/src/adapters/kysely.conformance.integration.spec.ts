import { PGlite } from "@electric-sql/pglite";
import { createTableStatements, coreSettings } from "@hot-updater/plugin-core";
import {
  SETTINGS_TABLE,
  settingsStatements,
} from "@hot-updater/plugin-core/internal";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

import { kyselyAdapter } from "./kysely";

/**
 * The adapter `kyselyAdapter` returns, schema fence included, on a new PGlite
 * per test that holds the conformance tables and the settings rows the fence
 * checks. PostgreSQL has no cap on one write and no native pages.
 */
setupDatabaseAdapterConformanceSuite({
  name: "kysely (PGlite)",
  createAdapter: async ({ tables }) => {
    const client = new PGlite();
    await client.exec(
      [
        ...createTableStatements("postgresql", [...tables, SETTINGS_TABLE]),
        ...settingsStatements("postgresql", coreSettings),
      ].join(";\n"),
    );
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    return {
      adapter: kyselyAdapter({ db, provider: "postgresql" }).adapter,
      cleanup: async () => {
        await db.destroy();
        await client.close();
      },
    };
  },
});
