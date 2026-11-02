import { PGlite } from "@electric-sql/pglite";
import {
  createSqlAdapter,
  createTableStatements,
  generateEngineSql,
  toolingTargetOf,
  WRITE_GUARD_TABLE,
} from "@hot-updater/plugin-core";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";

import { pgliteNeon } from "./neonDriver.testFixtures";
import { neonExecutor } from "./neonExecutor";

/**
 * `neonDatabase()`'s composition without its schema fence: the SQL core over
 * the Neon executor, on core's and the plugins' tables and the write guard,
 * as `hot-updater db migrate` creates them. Reads are explained on the same
 * PGlite, outside the driver.
 */
setupReadBudgetTestSuite({
  name: "neon HTTP (PGlite)",
  createAdapter: async () => {
    const db = new PGlite();
    const { schema, settings } = toolingTargetOf([
      insights(),
      apiKeys(),
      remoteConfig(),
    ]);
    await db.exec(
      [
        ...createTableStatements("postgresql", [WRITE_GUARD_TABLE]),
        ...generateEngineSql("postgresql", schema, settings),
      ].join(";\n"),
    );
    const reads = postgresRowsExamined(
      async (sql, params) =>
        (await db.query<Record<string, unknown>>(sql, [...params])).rows,
    );
    return {
      adapter: createSqlAdapter({
        executor: reads.wrap(neonExecutor(pgliteNeon(db))),
      }),
      examined: reads.examined,
      cleanup: () => db.close(),
    };
  },
});
