import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { kyselyExecutor } from "@hot-updater/server/adapters/kysely";
import { builtInSchema, createSqlAdapter } from "@hot-updater/server/database";
import {
  createMeasuredDatabase,
  targetBaseCandidateKey,
} from "@hot-updater/server/db";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

/**
 * `postgres({ dialect })`'s composition without its schema fence: the SQL
 * core over Kysely's executor on a PGlite dialect, on `sql/bundles.sql`.
 */
setupReadBudgetTestSuite({
  name: "postgres (PGlite)",
  server: {
    createMeasuredDatabase,
    builtInSchema,
    plugins: [insights(), apiKeys()],
    targetBaseCandidateKey,
  },
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(
      await fs.readFile(
        path.join(import.meta.dirname, "../sql/bundles.sql"),
        "utf8",
      ),
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
