import { PGlite } from "@electric-sql/pglite";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

import { builtInSettings } from "../database/builtInDatabase";
import { SETTINGS_TABLE } from "../database/fence";
import { createTableStatements } from "../database/sql/sqlSchema";
import { settingsStatements } from "../db/engineSql";
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
        ...settingsStatements("postgresql", builtInSettings),
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
