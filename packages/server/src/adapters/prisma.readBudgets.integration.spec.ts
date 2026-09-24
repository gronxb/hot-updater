import { PGlite } from "@electric-sql/pglite";
import {
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";

import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { readBudgetServer } from "../readBudgets.testFixtures";
import { prismaAdapter } from "./prisma";
import { prismaExecutor } from "./prismaExecutor";
import { pglitePrisma, prismaPushSql } from "./prismaTestClients";

/**
 * `prismaAdapter`'s composition without its schema fence: the SQL core over
 * the Prisma executor, through Prisma's raw query API on PGlite, on the
 * tables `prisma db push` creates and its migrator completes.
 */
setupReadBudgetTestSuite({
  name: "prisma (PGlite)",
  server: readBudgetServer,
  createAdapter: async () => {
    const client = new PGlite();
    await client.exec(await prismaPushSql("postgresql"));
    const prisma = pglitePrisma(client);
    const migrator = prismaAdapter({ prisma, provider: "postgresql" })
      .createMigrator!();
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
