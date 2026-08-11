import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  DATABASE_PLUGIN_TEST_RESET_SQL,
  DATABASE_PLUGIN_TEST_SCHEMA_SQL,
} from "./databasePluginTestDatabase";
import { kyselyAdapter } from "./kysely";

class KyselyTestStateError extends Error {
  readonly name = "KyselyTestStateError";
}

let client: PGlite | undefined;
let database: Kysely<object> | undefined;

const getClient = (): PGlite => {
  if (client === undefined) throw new KyselyTestStateError();
  return client;
};

const getDatabase = (): Kysely<object> => {
  if (database === undefined) throw new KyselyTestStateError();
  return database;
};

setupDatabasePluginTestSuite({
  name: "kyselyAdapter PostgreSQL",
  migrate: async () => {
    client = new PGlite();
    database = new Kysely<object>({ dialect: new PGliteDialect(client) });
    await client.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
  },
  createPlugin: (): DatabaseAdapterWithCapabilities =>
    kyselyAdapter({ db: getDatabase(), provider: "postgresql" }),
  reset: async () => {
    await getClient().exec(DATABASE_PLUGIN_TEST_RESET_SQL);
  },
  dispose: async () => {
    await getDatabase().destroy();
    await getClient().close();
    database = undefined;
    client = undefined;
  },
});

describe("kyselyAdapter SQLite JSON storage", () => {
  it("round-trips JSON values through text columns", async () => {
    const sqliteClient = new PGlite();
    const sqliteDatabase = new Kysely<object>({
      dialect: new PGliteDialect(sqliteClient),
    });
    await sqliteClient.exec(
      DATABASE_PLUGIN_TEST_SCHEMA_SQL.replace(
        "metadata jsonb not null default '{}'::jsonb",
        "metadata text not null",
      ).replace("target_cohorts jsonb", "target_cohorts text"),
    );
    const plugin = kyselyAdapter({ db: sqliteDatabase, provider: "sqlite" });
    const row = {
      ...createBundleRowFixture("901"),
      metadata: { app_version: "1.0.0" },
      target_cohorts: ["17", "qa-group"],
    };

    await plugin.commit({
      operation: "insert",
      bundleId: row.id,
      changes: [{ table: "bundles", operation: "insert", row }],
    });
    const stored = await sqliteClient.query<{
      metadata: string;
      target_cohorts: string;
    }>("select metadata, target_cohorts from bundles where id = $1", [row.id]);

    expect(stored.rows[0]).toEqual({
      metadata: JSON.stringify(row.metadata),
      target_cohorts: JSON.stringify(row.target_cohorts),
    });
    await expect(plugin.bundles.findById(row.id)).resolves.toEqual(row);
    await sqliteDatabase.destroy();
    await sqliteClient.close();
  });
});

describe("kyselyAdapter soft relations", () => {
  it("rejects an orphan patch and rolls back its owner row", async () => {
    const softClient = new PGlite();
    const softDatabase = new Kysely<object>({
      dialect: new PGliteDialect(softClient),
    });
    await softClient.exec(
      DATABASE_PLUGIN_TEST_SCHEMA_SQL.replaceAll(
        " references bundles(id) on delete cascade",
        "",
      ),
    );
    const plugin = kyselyAdapter({
      db: softDatabase,
      provider: "postgresql",
      relationMode: "fumadb",
    });
    const owner = createBundleRowFixture("952");
    const patch = createBundlePatchRowFixture(
      "missing-base",
      owner.id,
      "missing-base",
    );

    try {
      await expect(
        plugin.commit({
          operation: "insert",
          bundleId: owner.id,
          changes: [
            { table: "bundles", operation: "insert", row: owner },
            { table: "bundle_patches", operation: "insert", row: patch },
          ],
        }),
      ).rejects.toThrow("bundle_patches.base_bundle_id.foreign-key");
      await expect(plugin.bundles.findById(owner.id)).resolves.toBeNull();
    } finally {
      await softDatabase.destroy();
      await softClient.close();
    }
  });
});
