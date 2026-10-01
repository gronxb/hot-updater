import { PGlite } from "@electric-sql/pglite";
import { createSqlAdapter, toolingTargetOf } from "@hot-updater/plugin-core";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";

import { apiKeys } from "../plugins/api-keys";
import { insights } from "../plugins/insights";
import { prismaAdapter } from "./prisma";
import { prismaExecutor } from "./prismaExecutor";
import { pglitePrisma, prismaPushSql } from "./prismaTestClients";

/** Core's tables and those of the plugins the suite measures. */
const target = toolingTargetOf([insights(), apiKeys()]);

/**
 * `prismaAdapter`'s composition without its schema fence: the SQL core over
 * the Prisma executor, through Prisma's raw query API on PGlite, on the
 * tables `prisma db push` creates and its migrator completes.
 */
setupReadBudgetTestSuite({
  name: "prisma (PGlite)",
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(await prismaPushSql("postgresql", target));
    const prisma = pglitePrisma(client);
    const migrator = prismaAdapter({ prisma, provider: "postgresql" })
      .createMigrator!(target);
    await (await migrator.migrateToLatest()).execute();
    const reads = postgresRowsExamined(
      async (sql, params) =>
        (await client.query<Record<string, unknown>>(sql, [...params])).rows,
    );
    return {
      adapter: createSqlAdapter({
        executor: reads.wrap(prismaExecutor(prisma, "postgresql")),
      }),
      examined: reads.examined,
      cleanup: () => client.close(),
    };
  },
});
