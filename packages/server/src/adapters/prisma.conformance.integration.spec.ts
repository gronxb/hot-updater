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

import { prismaAdapter } from "./prisma";
import { pglitePrisma } from "./prismaTestClients";

/**
 * The adapter `prismaAdapter` returns, schema fence included, over Prisma's
 * raw query API on a new PGlite per test. Prisma has no models for the
 * conformance tables, so the SQL core's DDL creates them, beside the settings
 * rows the fence checks. PostgreSQL has no cap on one write and no native
 * pages.
 */
setupDatabaseAdapterConformanceSuite({
  name: "prisma (PGlite)",
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
    return {
      adapter: prismaAdapter({
        prisma: pglitePrisma(client),
        provider: "postgresql",
      }).adapter,
      cleanup: () => client.close(),
    };
  },
});
