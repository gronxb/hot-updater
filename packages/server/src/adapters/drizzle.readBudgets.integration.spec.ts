import { PGlite } from "@electric-sql/pglite";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { drizzle } from "drizzle-orm/pglite";

import { builtInSchema, builtInSettings } from "../database/builtInDatabase";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { generateEngineSql } from "../db/engineSql";
import { readBudgetServer } from "../readBudgets.testFixtures";
import { drizzleExecutor } from "./drizzleExecutor";

/**
 * `drizzleAdapter`'s composition without its schema fence: the SQL core over
 * the Drizzle executor on `drizzle-orm/pglite`, on the tables drizzle-kit
 * applies from the generated schema, with the settings rows.
 */
setupReadBudgetTestSuite({
  name: "drizzle (PGlite)",
  server: readBudgetServer,
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(
      generateEngineSql("postgresql", builtInSchema, builtInSettings).join(
        ";\n",
      ),
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
