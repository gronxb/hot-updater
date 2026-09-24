import { PGlite } from "@electric-sql/pglite";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { readBudgetServer } from "../readBudgets.testFixtures";
import { kyselyAdapter } from "./kysely";
import { kyselyExecutor } from "./kyselyExecutor";

/**
 * `kyselyAdapter`'s composition without its schema fence: the SQL core over
 * the Kysely executor on PGlite, on the tables its migrator creates.
 */
setupReadBudgetTestSuite({
  name: "kysely (PGlite)",
  server: readBudgetServer,
  createAdapter: async () => {
    const client = new PGlite();
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    const migrator = kyselyAdapter({ db, provider: "postgresql" })
      .createMigrator!();
    await (await migrator.migrateToLatest()).execute();
    const reads = postgresRowsExamined(
      async (sql, params) =>
        (await client.query<Record<string, unknown>>(sql, [...params])).rows,
    );
    return {
      adapter: createSqlAdapter({
        executor: reads.wrap(kyselyExecutor(db, "postgresql")),
      }),
      examined: reads.examined,
      cleanup: async () => {
        await db.destroy();
        await client.close();
      },
    };
  },
});
