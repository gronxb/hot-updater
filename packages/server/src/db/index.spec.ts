import { PGliteDialect } from "kysely-pglite-dialect";
import { PGlite } from "@electric-sql/pglite";
import { describe, beforeAll, beforeEach, afterAll } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
// no fs required when using FumaDB migrator

import { HotUpdaterDB, hotUpdater } from "./index";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { kyselyAdapter } from "fumadb/adapters/kysely";

describe("server/db hotUpdater getUpdateInfo (PGlite + Kysely)", async () => {
  const db = new PGlite();

  const kysely = new Kysely({ dialect: new PGliteDialect(db) });

  const client = HotUpdaterDB.client(
    kyselyAdapter({ db: kysely, provider: "postgresql" }),
  );
  const api = hotUpdater(client);

  beforeAll(async () => {
    // Initialize FumaDB schema to latest (creates tables under the hood)
    const migrator = client.createMigrator();
    await migrator.migrateToLatest();
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await kysely.destroy();
    await db.close();
  });

  const getUpdateInfo = async (
    bundles: Bundle[],
    options: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    // Insert fixtures via the server API to exercise its types + mapping
    for (const b of bundles) {
      await api.insertBundle(b);
    }
    return api.getUpdateInfo(options);
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });
});
