import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  DATABASE_PLUGIN_TEST_RESET_SQL,
  DATABASE_PLUGIN_TEST_SCHEMA_SQL,
} from "./databasePluginTestDatabase";
import { kyselyAdapter } from "./kysely";
import { migrateKyselyInsights } from "./sqlInsights/kysely";

const insightsDatabaseNamespace = "00000000-0000-4000-8000-000000000001";

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
    await migrateKyselyInsights(
      database,
      "postgresql",
      insightsDatabaseNamespace,
    );
  },
  createPlugin: (): DatabaseAdapterWithCapabilities =>
    kyselyAdapter({
      db: getDatabase(),
      provider: "postgresql",
    }),
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
      ),
    );
    const plugin = kyselyAdapter({
      db: sqliteDatabase,
      provider: "sqlite",
    });
    const row = {
      ...createBundleRowFixture("901"),
      metadata: { app_version: "1.0.0" },
    };

    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row }],
    });
    const stored = await sqliteClient.query<{
      metadata: string;
    }>("select metadata from bundles where id = $1", [row.id]);

    expect(stored.rows[0]).toEqual({
      metadata: JSON.stringify(row.metadata),
    });
    await expect(plugin.models.bundles.findById(row.id)).resolves.toEqual(row);
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
    const channel = createChannelRowFixture();

    try {
      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: channel,
              onConflict: "ignore",
            },
            { model: "bundles", operation: "insert", row: owner },
            {
              model: "bundlePatches",
              operation: "insert",
              row: patch,
            },
          ],
        }),
      ).rejects.toThrow("bundle_patches.base_bundle_id.foreign-key");
      await expect(
        plugin.models.bundles.findById(owner.id),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    } finally {
      await softDatabase.destroy();
      await softClient.close();
    }
  });
});
