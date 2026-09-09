import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleEventRowFixture,
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
  it("keeps failed event inserts absent and permits retry", async () => {
    const db = new PGlite();
    const kysely = new Kysely<object>({ dialect: new PGliteDialect(db) });
    await db.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
    await db.exec(
      "alter table bundle_events add constraint reject_event check (install_id <> 'install-703')",
    );
    const plugin = kyselyAdapter({ db: kysely, provider: "postgresql" });
    const event = createBundleEventRowFixture("703", 100);
    const input = { event };
    try {
      await expect(plugin.models.insights.record(input)).rejects.toThrow();
      expect((await db.query("select id from bundle_events")).rows).toEqual([]);
      await db.exec("alter table bundle_events drop constraint reject_event");
      await plugin.models.insights.record(input);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([input.event]);
    } finally {
      await kysely.destroy();
      await db.close();
    }
  });
  it("decodes text-backed event metadata in history and latest reads", async () => {
    const client = new PGlite();
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    await client.exec(
      DATABASE_PLUGIN_TEST_SCHEMA_SQL.replace(
        "metadata jsonb not null,",
        "metadata text not null,",
      ),
    );
    const insights = kyselyAdapter({ db, provider: "sqlite" }).models.insights;
    const base = createBundleEventRowFixture("704", 100);
    const event = {
      ...base,
      metadata: { ...base.metadata, device: { tags: [null, "ko-KR"] } },
    };
    try {
      await insights.record({ event });
      expect(
        (await client.query("select metadata from bundle_events")).rows,
      ).toEqual([{ metadata: JSON.stringify(event.metadata) }]);
      await expect(
        insights.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([event]);
      await expect(
        insights.listEvents({
          filter: { kind: "all" },
          beforeReceivedAtMs: 101,
          limit: 10,
        }),
      ).resolves.toEqual([event]);
    } finally {
      await db.destroy();
      await client.close();
    }
  });

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
    const plugin = kyselyAdapter({ db: sqliteDatabase, provider: "sqlite" });
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
