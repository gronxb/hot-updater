import { PGlite } from "@electric-sql/pglite";
import {
  createSqlAdapter,
  toolingTargetOf,
  generateEngineSql,
} from "@hot-updater/plugin-core";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { drizzle } from "drizzle-orm/pglite";

import { apiKeys } from "../plugins/api-keys";
import { insights } from "../plugins/insights";
import { drizzleExecutor } from "./drizzleExecutor";

/**
 * `drizzleAdapter`'s composition without its schema fence: the SQL core over
 * the Drizzle executor on `drizzle-orm/pglite`, on the tables drizzle-kit
 * applies from the generated schema, with the settings rows.
 */
setupReadBudgetTestSuite({
  name: "drizzle (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(
      generateEngineSql(
        "postgresql",
        toolingTargetOf([insights(), apiKeys()]).schema,
        toolingTargetOf([insights(), apiKeys()]).settings,
      ).join(";\n"),
    );
    const reads = postgresRowsExamined(
      async (sql, params) =>
        (await client.query<Record<string, unknown>>(sql, [...params])).rows,
    );
    return {
      adapter: createSqlAdapter({
        executor: reads.wrap(drizzleExecutor(drizzle(client), "postgresql")),
      }),
      examined: reads.examined,
      cleanup: () => client.close(),
    };
  },
});
