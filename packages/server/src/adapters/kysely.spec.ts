import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  DATABASE_ADAPTER_TEST_RESET_SQL,
  DATABASE_ADAPTER_TEST_SCHEMA_SQL,
} from "./databaseAdapterTestDatabase";
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

setupDatabaseAdapterTestSuite({
  name: "kyselyAdapter PostgreSQL",
  migrate: async () => {
    client = new PGlite();
    database = new Kysely({ dialect: new PGliteDialect(client) });
    await client.exec(DATABASE_ADAPTER_TEST_SCHEMA_SQL);
  },
  createAdapter: (): DatabaseAdapterWithCapabilities =>
    kyselyAdapter({ db: getDatabase(), provider: "postgresql" }),
  reset: async () => {
    await getClient().exec(DATABASE_ADAPTER_TEST_RESET_SQL);
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
    // Given
    const sqliteClient = new PGlite();
    const sqliteDatabase = new Kysely({
      dialect: new PGliteDialect(sqliteClient),
    });
    await sqliteClient.exec(
      DATABASE_ADAPTER_TEST_SCHEMA_SQL.replace(
        "metadata jsonb not null default '{}'::jsonb",
        "metadata text not null",
      ).replace("target_cohorts jsonb", "target_cohorts text"),
    );
    const adapter = kyselyAdapter({
      db: sqliteDatabase,
      provider: "sqlite",
    });
    const bundle = {
      ...createBundleRowFixture("901"),
      metadata: { app_version: "1.0.0" },
      target_cohorts: ["17", "qa-group"],
    };

    // When
    await adapter.create({
      model: "channels",
      data: { id: "channel-production", name: "production" },
    });
    await adapter.create({ model: "bundles", data: bundle });
    const stored = await sqliteClient.query<{
      metadata: string;
      target_cohorts: string;
    }>("select metadata, target_cohorts from bundles where id = $1", [
      bundle.id,
    ]);
    const restored = await adapter.findOne({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
    });

    // Then
    expect(stored.rows[0]).toEqual({
      metadata: JSON.stringify(bundle.metadata),
      target_cohorts: JSON.stringify(bundle.target_cohorts),
    });
    expect(restored).toEqual(bundle);
    await sqliteDatabase.destroy();
    await sqliteClient.close();
  });
});

describe("kyselyAdapter soft relations", () => {
  it("rejects orphan patches when the SQL schema omits foreign keys", async () => {
    const softClient = new PGlite();
    const queries: string[] = [];
    const softDatabase = new Kysely({
      dialect: new PGliteDialect(softClient),
      log: (event) => {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
    await softClient.exec(
      DATABASE_ADAPTER_TEST_SCHEMA_SQL.replace(
        " references channels(id) on delete restrict",
        "",
      ).replaceAll(" references bundles(id) on delete restrict", ""),
    );
    const adapter = kyselyAdapter({
      db: softDatabase,
      provider: "postgresql",
      relationMode: "fumadb",
    });
    const base = createBundleRowFixture("951");
    const owner = createBundleRowFixture("952");

    try {
      await adapter.create({
        model: "channels",
        data: { id: "channel-production", name: "production" },
      });
      await adapter.create({ model: "bundles", data: base });
      await adapter.create({ model: "bundles", data: owner });
      queries.length = 0;

      await expect(
        adapter.create({
          model: "bundle_patches",
          data: createBundlePatchRowFixture(
            "missing-owner",
            "missing-owner",
            base.id,
          ),
        }),
      ).rejects.toThrow("bundle_patches.bundle_id.foreign-key");
      expect(queries.some((query) => query.endsWith("for update"))).toBe(true);
      await expect(
        adapter.create({
          model: "bundle_patches",
          data: createBundlePatchRowFixture(
            "missing-base",
            owner.id,
            "missing-base",
          ),
        }),
      ).rejects.toThrow("bundle_patches.base_bundle_id.foreign-key");
      await expect(
        adapter.findMany({ model: "bundle_patches" }),
      ).resolves.toEqual([]);
      queries.length = 0;
      await adapter.delete({
        model: "bundles",
        where: [{ field: "id", value: owner.id }],
      });
      expect(
        queries.some(
          (query) =>
            query.includes('select "id" from "bundles"') &&
            query.endsWith("for update"),
        ),
      ).toBe(true);
    } finally {
      await softDatabase.destroy();
      await softClient.close();
    }
  });
});
