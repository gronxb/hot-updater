import { MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createDatabasePluginCore } from "./databasePluginCore";
import { createMongoMigrator } from "./fixedMigrator";
import {
  executeMongoMigration,
  type MongoMigrationBackend,
} from "./mongoMigrationExecution";
import { createSchemaReadinessChecker } from "./schemaReadiness";

function createSettingsMongoClient(
  values: Readonly<Record<string, unknown>>,
): MongoClient {
  return {
    db: () => ({
      collection: () => ({
        find: ({ key }: { readonly key: string }) => ({
          limit: () => ({
            toArray: async () => {
              const value = values[key];
              return value === undefined ? [] : [{ key, value }];
            },
          }),
        }),
        listIndexes: () => ({
          toArray: async () => [{ key: { key: 1 }, unique: true }],
        }),
      }),
    }),
  } as unknown as MongoClient;
}

describe("MongoDB migration", () => {
  it("reads legacy composite version 0.37.0 as Core 0.37", async () => {
    const find = vi.fn(({ key }: { readonly key: string }) => ({
      limit: () => ({
        toArray: async () =>
          key === "version" ? [{ key, value: "0.37.0" }] : [],
      }),
    }));
    const client = {
      db: () => ({ collection: () => ({ find }) }),
    } as unknown as MongoClient;

    await expect(createMongoMigrator(client).getVersion()).resolves.toBe(
      "0.37.0",
    );
    expect(find).toHaveBeenCalledWith({ key: "schema.core" });
    expect(find).toHaveBeenCalledWith({ key: "version" });
  });

  it("creates a unique settings key index before recording Core readiness", async () => {
    const settings = new Map<string, unknown>([["version", "0.38.0"]]);
    const settingsCollection = {
      find: ({ key }: { readonly key: string }) => ({
        limit: () => ({
          toArray: async () => {
            const value = settings.get(key);
            return value === undefined ? [] : [{ key, value }];
          },
        }),
      }),
      createIndex: vi.fn(async (): Promise<string> => "key_1"),
      listIndexes: () => ({ toArray: async () => [] }),
      updateOne: async (
        { key }: { readonly key: string },
        update: { readonly $set: { readonly value: unknown } },
      ) => void settings.set(key, update.$set.value),
    };
    const modelCollection = {
      find: () => ({ toArray: async () => [] }),
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => "created",
    };
    const database = {
      command: vi.fn(async () => undefined),
      createCollection: async () => undefined,
      collection: (name: string) =>
        name === "private_hot_updater_settings"
          ? settingsCollection
          : modelCollection,
    };
    const client = { db: () => database } as unknown as MongoClient;

    await (
      await createMongoMigrator(client).migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      })
    ).execute();

    expect(settingsCollection.createIndex).toHaveBeenCalledWith(
      { key: 1 },
      { unique: true },
    );
    expect(settings).toEqual(
      new Map([
        ["version", "0.38.0"],
        ["schema.core", "1.0.0"],
      ]),
    );
  });

  it("repairs the settings key index when Core is already current", async () => {
    const createIndex = vi.fn(async (): Promise<string> => "key_1");
    const client = {
      db: () => ({
        collection: () => ({
          createIndex,
          find: ({ key }: { readonly key: string }) => ({
            limit: () => ({
              toArray: async () =>
                key === "schema.core"
                  ? [{ key, value: "1.0.0" }]
                  : [{ key, value: "0.38.0" }],
            }),
          }),
          listIndexes: () => ({ toArray: async () => [] }),
        }),
      }),
    } as unknown as MongoClient;

    const migration = await createMongoMigrator(client).migrateToLatest({
      mode: "from-schema",
    });

    expect(migration.operations).toEqual([
      {
        description:
          "Ensure unique MongoDB index: private_hot_updater_settings(key)",
        type: "custom",
      },
    ]);
    expect(createIndex).not.toHaveBeenCalled();

    await migration.execute();

    expect(createIndex).toHaveBeenCalledOnce();
    expect(createIndex).toHaveBeenCalledWith({ key: 1 }, { unique: true });
  });

  it("rejects duplicate Core markers before selecting a version", async () => {
    const find = vi.fn(({ key }: { readonly key: string }) => ({
      limit: () => ({
        toArray: async () =>
          key === "schema.core"
            ? [
                { key, value: "0.37.0" },
                { key, value: "0.37.0" },
              ]
            : [],
      }),
    }));
    const client = {
      db: () => ({
        collection: () => ({
          find,
        }),
      }),
    } as unknown as MongoClient;

    await expect(createMongoMigrator(client).getVersion()).rejects.toThrow(
      "Duplicate Hot Updater schema setting: schema.core",
    );
    expect(find).toHaveBeenCalledWith({ key: "schema.core" });
  });

  it("rejects a non-unique settings key index before changing it", async () => {
    const createIndex = vi.fn();
    const dropIndex = vi.fn();
    const client = {
      db: () => ({
        collection: () => ({
          createIndex,
          dropIndex,
          find: ({ key }: { readonly key: string }) => ({
            limit: () => ({
              toArray: async () =>
                key === "schema.core"
                  ? [{ key, value: "1.0.0" }]
                  : [{ key, value: "0.38.0" }],
            }),
          }),
          listIndexes: () => ({
            toArray: async () => [
              { key: { key: 1 }, name: "key_1", unique: false },
            ],
          }),
        }),
      }),
    } as unknown as MongoClient;

    await expect(
      createMongoMigrator(client).migrateToLatest({ mode: "from-schema" }),
    ).rejects.toThrow(
      "Hot Updater settings key index must enforce uniqueness for every key.",
    );
    expect(createIndex).not.toHaveBeenCalled();
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it("keeps one Core marker when cold migrations execute concurrently", async () => {
    const settings: { key: string; value: unknown }[] = [];
    const calls: string[] = [];
    let hasUniqueSettingsKeys = false;
    const settingsCollection = {
      find: ({ key }: { readonly key: string }) => ({
        limit: () => ({
          toArray: async () => settings.filter((item) => item.key === key),
        }),
      }),
      createIndex: async (): Promise<string> => {
        calls.push("settings index");
        hasUniqueSettingsKeys = true;
        return "key_1";
      },
      listIndexes: () => ({
        toArray: async () =>
          hasUniqueSettingsKeys ? [{ key: { key: 1 }, unique: true }] : [],
      }),
      updateOne: async (
        { key }: { readonly key: string },
        update: { readonly $set: { readonly value: unknown } },
      ) => {
        if (!hasUniqueSettingsKeys) {
          throw new Error("Schema marker write requires unique settings keys");
        }
        calls.push("marker");
        const row = settings.find((item) => item.key === key);
        if (row) {
          row.value = update.$set.value;
        } else {
          settings.push({ key, value: update.$set.value });
        }
      },
    };
    const modelCollection = {
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async (): Promise<string> => "created",
    };
    const database = {
      command: async () => undefined,
      createCollection: async () => undefined,
      collection: (name: string) =>
        name === "private_hot_updater_settings"
          ? settingsCollection
          : modelCollection,
    };
    const client = { db: () => database } as unknown as MongoClient;

    const [first, second] = await Promise.all([
      createMongoMigrator(client).migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      }),
      createMongoMigrator(client).migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      }),
    ]);
    await Promise.all([first.execute(), second.execute()]);

    expect(settings).toEqual([{ key: "schema.core", value: "1.0.0" }]);
    expect(calls.at(-1)).toBe("marker");
  });

  it.each(["0.21.0", "0.29.0", "0.31.0", "0.36.0", "0.37.0", "0.38.0"])(
    "accepts known legacy version %s alongside a current Core marker",
    async (legacyVersion) => {
      const client = createSettingsMongoClient({
        "schema.core": "1.0.0",
        version: legacyVersion,
      });
      const migrator = createMongoMigrator(client);

      await expect(migrator.getVersion()).resolves.toBe("1.0.0");
      await expect(
        migrator.migrateToLatest({ mode: "from-schema" }),
      ).resolves.toMatchObject({ operations: [] });
    },
  );

  it.each(["0.39.0", "unknown"])(
    "rejects legacy MongoDB %s alongside a current Core marker before reading bundle data",
    async (legacyVersion) => {
      const client = createSettingsMongoClient({
        "schema.core": "1.0.0",
        version: legacyVersion,
      });
      const migrator = createMongoMigrator(client);
      const plugin = createInMemoryDatabasePlugin();
      const count = vi.spyOn(plugin.models.bundles, "count");
      const findMany = vi.spyOn(plugin.models.bundles, "findMany");
      const core = createDatabasePluginCore(plugin, async () => null, {
        beforeOperation: createSchemaReadinessChecker(
          "future-mongodb",
          () => migrator,
        ),
      });

      const result = core.api.getBundles({ limit: 1 });

      await expect(result).rejects.toThrow(
        `Unsupported Hot Updater schema version: ${legacyVersion}`,
      );
      expect(count).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "Core marker alone",
      { "schema.core": { version: "1.0.0" } },
      "schema.core",
    ],
    ["legacy marker alone", { version: { version: "0.37.0" } }, "version"],
    [
      "Core marker beside a valid legacy marker",
      { "schema.core": { version: "1.0.0" }, version: "0.37.0" },
      "schema.core",
    ],
    [
      "legacy marker beside a current Core marker",
      { "schema.core": "1.0.0", version: { version: "0.37.0" } },
      "version",
    ],
  ] as const)("rejects a corrupt %s", async (_case, values, key) => {
    const migrator = createMongoMigrator(createSettingsMongoClient(values));

    await expect(migrator.getVersion()).rejects.toThrow(
      `Invalid Hot Updater schema setting: ${key}`,
    );
  });

  it("backfills Releases and catalogs before stripping MongoDB Bundle policy", async () => {
    const calls: string[] = [];
    const settings = new Map<string, unknown>([["schema.core", "0.37.0"]]);
    const bundles: Record<string, unknown>[] = [
      {
        id: "bundle-1",
        platform: "ios",
        file_hash: "hash-1",
        storage_uri: "storage://bundle-1",
        should_force_update: false,
        enabled: true,
        message: "first",
        channel: "production",
        target_app_version: "1.x",
        fingerprint_hash: null,
        rollout_cohort_count: 1000,
        target_cohorts: null,
      },
      {
        id: "bundle-2",
        platform: "ios",
        file_hash: "hash-2",
        storage_uri: "storage://bundle-2",
        should_force_update: true,
        enabled: false,
        message: null,
        channel: "production",
        target_app_version: "2.x",
        fingerprint_hash: null,
        rollout_cohort_count: 500,
        target_cohorts: ["qa"],
      },
      {
        id: "bundle-3",
        platform: "android",
        file_hash: "hash-3",
        storage_uri: "storage://bundle-3",
        should_force_update: false,
        enabled: true,
        message: null,
        channel: "beta",
        target_app_version: null,
        fingerprint_hash: "fingerprint",
        rollout_cohort_count: 1000,
        target_cohorts: [],
      },
    ];
    const channels: { id: string; name: string }[] = [];
    const releases: Record<string, unknown>[] = [];
    const catalogs: Record<string, unknown>[] = [];
    const settingsCollection = {
      find: ({ key }: { readonly key: string }) => ({
        limit: () => ({
          toArray: async () => {
            const value = settings.get(key);
            return value === undefined ? [] : [{ key, value }];
          },
        }),
      }),
      listIndexes: () => ({
        toArray: async () => [{ key: { key: 1 }, unique: true }],
      }),
      createIndex: async () => "key_1",
      updateOne: async (
        { key }: { readonly key: string },
        update: { readonly $set: { readonly value: unknown } },
      ) => {
        calls.push("marker");
        settings.set(key, update.$set.value);
      },
    };
    const bundlesCollection = {
      find: () => ({ toArray: async () => bundles.map((row) => ({ ...row })) }),
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => "created",
      updateOne: async (
        { id }: { readonly id: string },
        update: {
          readonly $set: Record<string, unknown>;
          readonly $unset: Record<string, unknown>;
        },
      ) => {
        const bundle = bundles.find((row) => row["id"] === id);
        if (!bundle) throw new Error(`Missing Bundle ${id}`);
        Object.assign(bundle, update.$set);
        for (const field of Object.keys(update.$unset)) {
          delete bundle[field];
        }
      },
    };
    const channelsCollection = {
      find: (filter: { readonly name?: string }) => {
        const rows = () =>
          filter.name === undefined
            ? [...channels]
            : channels.filter(({ name }) => name === filter.name);
        return {
          limit: (limit: number) => ({
            toArray: async () => rows().slice(0, limit),
          }),
          toArray: async () => rows(),
        };
      },
      findOne: async ({ name }: { readonly name: string }) =>
        channels.find((channel) => channel.name === name) ?? null,
      insertOne: async (row: {
        readonly id: string;
        readonly name: string;
      }) => {
        channels.push(row);
      },
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async (
        _keys: object,
        options: { readonly name?: string; readonly unique?: boolean },
      ) => {
        if (options.name === "channels_name_key") {
          expect(options.unique).toBe(true);
          calls.push("unique-channel-name");
        }
        return options.name ?? "created";
      },
    };
    const replaceableCollection = (
      rows: Record<string, unknown>[],
      key: "id" | "scope_key",
      call: string,
    ) => ({
      find: (filter: Record<string, unknown>) => ({
        toArray: async () =>
          rows
            .filter((row) =>
              Object.entries(filter).every(([field, expected]) => {
                if (
                  typeof expected === "object" &&
                  expected !== null &&
                  "$in" in expected
                ) {
                  return (expected["$in"] as unknown[]).includes(row[field]);
                }
                return row[field] === expected;
              }),
            )
            .map((row) => ({ ...row })),
      }),
      replaceOne: async (
        filter: Record<string, unknown>,
        row: Record<string, unknown>,
      ) => {
        const index = rows.findIndex((item) => item[key] === filter[key]);
        if (index < 0) rows.push({ ...row });
        else rows[index] = { ...row };
        calls.push(call);
      },
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => "created",
    });
    const modelCollection = {
      find: () => ({ toArray: async () => [] }),
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => "created",
    };
    const database = {
      command: vi.fn(async () => {
        calls.push("validator");
      }),
      createCollection: async () => undefined,
      collection: (name: string) => {
        if (name === "private_hot_updater_settings") {
          return settingsCollection;
        }
        if (name === "bundles") return bundlesCollection;
        if (name === "channels") return channelsCollection;
        if (name === "releases") {
          return replaceableCollection(releases, "id", "release");
        }
        if (name === "release_catalogs") {
          return replaceableCollection(catalogs, "scope_key", "catalog");
        }
        return modelCollection;
      },
    };
    const migrator = createMongoMigrator({
      db: () => database,
    } as unknown as MongoClient);
    const migration = await migrator.migrateToLatest({
      authorityId: "project-a",
      mode: "from-schema",
      updateSettings: true,
    });

    expect(migration.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description:
            "Backfill persistent MongoDB channels for legacy Bundle policy",
        }),
        expect.objectContaining({
          description:
            "Backfill MongoDB Releases and compiled Release catalogs from Bundle policy",
        }),
      ]),
    );

    await migration.execute();

    expect(channels.map(({ name }) => name).sort()).toEqual([
      "beta",
      "production",
    ]);
    expect(releases).toHaveLength(3);
    expect(releases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundle_id: "bundle-1",
          id: "bundle-1",
          revision: 1,
          operation: "DEPLOY",
        }),
        expect.objectContaining({
          bundle_id: "bundle-2",
          enabled: false,
          rollout_cohort_count: 500,
          target_cohorts: ["qa"],
        }),
      ]),
    );
    expect(catalogs).toHaveLength(2);
    expect(catalogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authority_id: "project-a",
          generation: 1,
          payload: expect.any(String),
          catalog_hash: expect.stringMatching(/^sha256:/),
        }),
      ]),
    );
    expect(
      bundles.every((bundle) =>
        [
          "channel",
          "channel_id",
          "enabled",
          "target_app_version",
          "fingerprint_hash",
        ].every((field) => !(field in bundle)),
      ),
    ).toBe(true);
    expect(calls.indexOf("unique-channel-name")).toBeGreaterThan(
      calls.findLastIndex((call) => call === "catalog"),
    );
    expect(calls.indexOf("validator")).toBeGreaterThan(
      calls.indexOf("unique-channel-name"),
    );
    expect(calls.at(-1)).toBe("marker");
    expect(settings.get("schema.core")).toBe("1.0.0");
    expect(database.command).toHaveBeenCalledWith(
      expect.objectContaining({
        collMod: "bundles",
        validator: expect.objectContaining({ $and: expect.any(Array) }),
      }),
    );
    expect(database.command).toHaveBeenCalledWith(
      expect.objectContaining({ collMod: "releases" }),
    );
    expect(database.command).toHaveBeenCalledWith(
      expect.objectContaining({ collMod: "release_catalogs" }),
    );
  });

  it("rejects a 256-code-point legacy MongoDB channel before indexing or versioning", async () => {
    const createIndex = vi.fn();
    const updateOne = vi.fn();
    const command = vi.fn();
    const settingsCollection = {
      find: ({ key }: { readonly key: string }) => ({
        limit: () => ({
          toArray: async () =>
            key === "schema.core" ? [{ key, value: "0.37.0" }] : [],
        }),
      }),
      listIndexes: () => ({
        toArray: async () => [{ key: { key: 1 }, unique: true }],
      }),
      createIndex,
      updateOne,
    };
    const invalidBundle = {
      id: "bundle-invalid",
      platform: "ios",
      file_hash: "hash",
      storage_uri: "storage://bundle-invalid",
      should_force_update: false,
      enabled: true,
      message: null,
      channel: "😀".repeat(256),
      target_app_version: "1.x",
      fingerprint_hash: null,
      rollout_cohort_count: 1000,
      target_cohorts: [],
    };
    const bundlesCollection = {
      find: () => ({ toArray: async () => [{ ...invalidBundle }] }),
    };
    const database = {
      command,
      createCollection: async () => undefined,
      collection: (name: string) => {
        if (name === "private_hot_updater_settings") {
          return settingsCollection;
        }
        if (name === "bundles") return bundlesCollection;
        return {};
      },
    };
    const migrator = createMongoMigrator({
      db: () => database,
    } as unknown as MongoClient);
    const migration = await migrator.migrateToLatest({
      authorityId: "project-a",
      mode: "from-schema",
      updateSettings: true,
    });

    await expect(migration.execute()).rejects.toThrow(
      "Channel name must not exceed 255 characters",
    );
    expect(createIndex).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("backfills, validates, indexes, and enforces before updating the version", async () => {
    const calls: string[] = [];
    const backend: MongoMigrationBackend = {
      ensureCollections: async () => void calls.push("collections"),
      backfillData: async () => void calls.push("backfill"),
      validateData: async () => void calls.push("validate"),
      ensureIndexes: async () => void calls.push("indexes"),
      enforceSchema: async () => void calls.push("schema"),
      updateVersion: async () => void calls.push("version"),
    };

    await executeMongoMigration({ backend, updateSettings: true });

    expect(calls).toEqual([
      "collections",
      "backfill",
      "validate",
      "indexes",
      "schema",
      "version",
    ]);
  });
});
