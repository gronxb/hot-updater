import { PGlite } from "@electric-sql/pglite";
import { createSqlAdapter, toolingTargetOf } from "@hot-updater/plugin-core";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

import { apiKeys } from "../plugins/api-keys";
import { insights } from "../plugins/insights";
import { remoteConfig } from "../plugins/remote-config";
import { kyselyAdapter } from "./kysely";
import { kyselyExecutor } from "./kyselyExecutor";

/**
 * `kyselyAdapter`'s composition without its schema fence: the SQL core over
 * the Kysely executor on PGlite, on the tables its migrator creates for core
 * and the plugins the suite measures.
 */
setupReadBudgetTestSuite({
  name: "kysely (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    const target = toolingTargetOf([insights(), apiKeys(), remoteConfig()]);
    const migrator = kyselyAdapter({ db, provider: "postgresql" })
      .createMigrator!(target);
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
