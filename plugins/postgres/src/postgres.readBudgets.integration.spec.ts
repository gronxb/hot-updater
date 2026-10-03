import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  toolingTargetOf,
  createSqlAdapter,
  generateEngineSql,
} from "@hot-updater/plugin-core";
import { kyselyExecutor } from "@hot-updater/server/adapters/kysely";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

const plugins = [insights(), apiKeys()];

/**
 * `postgres({ dialect })`'s composition without its schema fence: the SQL
 * core over Kysely's executor on a PGlite dialect, on `sql/bundles.sql` and
 * the plugins' tables, as `hot-updater db migrate` adds them.
 */
setupReadBudgetTestSuite({
  name: "postgres (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(
      await fs.readFile(
        path.join(import.meta.dirname, "../sql/bundles.sql"),
        "utf8",
      ),
    );
    const { schema, settings } = toolingTargetOf(plugins);
    await client.exec(
      generateEngineSql("postgresql", schema, settings).join(";\n"),
    );
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
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
