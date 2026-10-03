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
      createTableStatements("postgresql", [...tables, SETTINGS_TABLE]).join(
        ";\n",
      ),
    );
    await writeSchemaSettings(
      createSqlAdapter({ executor: pgliteExecutor(client) }),
      "pglite",
      coreSettings,
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
