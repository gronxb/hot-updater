import { PGliteDialect } from "kysely-pglite-dialect";
import { PGlite } from "@electric-sql/pglite";
import { describe, beforeAll, beforeEach, afterAll } from "vitest";
import { Kysely } from "kysely";
// no fs required when using FumaDB migrator
// (no direct filesystem DDL calls; rely on FumaDB migrator)

import { HotUpdaterDB, hotUpdater } from "./index";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { kyselyAdapter } from "fumadb/adapters/kysely";

describe("server/db hotUpdater getUpdateInfo (PGlite + Kysely)", async () => {
  const db = new PGlite();

  const kysely = new Kysely({ dialect: new PGliteDialect(db) });

  const adapterConfig = {
    db: kysely,
    provider: "postgresql" as const,
  } as unknown as Parameters<typeof kyselyAdapter>[0];

  const client = HotUpdaterDB.client(kyselyAdapter(adapterConfig));
  const api = hotUpdater(client);

  beforeAll(async () => {
    // Initialize FumaDB schema to latest (creates tables under the hood)
    const migrator = client.createMigrator();
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
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
