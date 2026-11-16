/**
 * `releases.scopes` on a key-value store: each migration writes the items
 * of releases stored without them, as a 1.1.x server writes releases,
 * across pages and within the store's write limits.
 */
import {
  createEngineDatabase,
  createKvAdapter,
  encodeKvKey,
  type HotUpdaterCoreApi,
  type KeyValueStore,
  migrateCoreSchema,
} from "@hot-updater/plugin-core";
import {
  createMemoryKeyValueStore,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../../index";

const RELEASES = 120;
const SCOPES = { pk: "releases#scopes#", order: "asc", limit: 500 } as const;
const SETTING = {
  pk: "private_hot_updater_settings",
  sk: encodeKvKey(["schema.core"]),
};

const id = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** 120 releases in one scope on a migrated store, then their `scopes` items taken away. */
const seed = async () => {
  const store = createMemoryKeyValueStore();
  const database = createEngineDatabase({
    name: "kv",
    adapter: createKvAdapter({ store }),
  });
  await (await database.createMigrator!().migrateToLatest()).execute();
  const { core } = createHotUpdater({
    database,
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  }) as unknown as { core: HotUpdaterCoreApi };
  for (let n = 1; n <= RELEASES; n += 1) {
    await core.deploy([
      {
        bundle: {
          id: id(n),
          platform: "ios",
          gitCommitHash: null,
          manifestStorageUri: `storage://artifacts/${n}/manifest.json`,
          manifestFileHash: `manifest-hash-${n}`,
          assetBaseStorageUri: "storage://assets",
        },
        release: {
          channel: "production",
          enabled: n === RELEASES,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]);
  }
  const { items } = await store.query(SCOPES);
  expect(items).toHaveLength(RELEASES);
  await store.write(
    items.map(({ sk }) => ({
      type: "delete" as const,
      key: { pk: SCOPES.pk, sk },
    })),
  );
  return store;
};

/** The store as a migration sees it, refusing a write over 4 items. */
const limited = (store: KeyValueStore): KeyValueStore => ({
  ...store,
  limits: { items: 4, bytes: 4_000_000 },
  write: (ops) => {
    if (ops.length > 4) throw new Error(`${ops.length} items in one write`);
    return store.write(ops);
  },
});

const scopeItems = async (store: KeyValueStore) =>
  (await store.query(SCOPES)).items.length;

describe("releases.scopes items on a key-value store", () => {
  it("are written by the managed providers' migration", async () => {
    const store = await seed();

    await migrateCoreSchema(createKvAdapter({ store: limited(store) }), "kv");

    await expect(scopeItems(store)).resolves.toBe(RELEASES);
  });

  it("are written by db migrate on a 1.1.x database", async () => {
    const store = await seed();
    const [setting] = await store.get([SETTING]);
    await store.write([
      { type: "put", key: SETTING, value: { ...setting!, value: "1.0.0" } },
    ]);
    const database = createEngineDatabase({
      name: "kv",
      adapter: createKvAdapter({ store: limited(store) }),
    });

    const migration = await database.createMigrator!().migrateToLatest();
    expect(migration.operations.length).toBeGreaterThan(0);
    await migration.execute();

    await expect(scopeItems(store)).resolves.toBe(RELEASES);
    const [migrated] = await store.get([SETTING]);
    expect(migrated?.value).toBe("1.2.0");
  });
});
