import { PGlite } from "@electric-sql/pglite";
import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";

import { builtInSettings } from "../database/builtInDatabase";
import { SETTINGS_TABLE } from "../database/fence";
import { createTableStatements } from "../database/sql/sqlSchema";
import { settingsStatements } from "../db/engineSql";
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
      [
        ...createTableStatements("postgresql", [...tables, SETTINGS_TABLE]),
        ...settingsStatements("postgresql", builtInSettings),
      ].join(";\n"),
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
