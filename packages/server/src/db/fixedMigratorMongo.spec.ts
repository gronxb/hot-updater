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
  it.each(["0.37.0", "0.38.0"])(
    "adopts legacy composite version %s as Core 0.36",
    async (legacyVersion) => {
      const find = vi.fn(({ key }: { readonly key: string }) => ({
        limit: () => ({
          toArray: async () =>
            key === "version" ? [{ key, value: legacyVersion }] : [],
        }),
      }));
      const client = {
        db: () => ({ collection: () => ({ find }) }),
      } as unknown as MongoClient;

      await expect(createMongoMigrator(client).getVersion()).resolves.toBe(
        "0.36.0",
      );
      expect(find).toHaveBeenCalledWith({ key: "schema.core" });
      expect(find).toHaveBeenCalledWith({ key: "version" });
    },
  );

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
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => "created",
    };
    const database = {
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
        ["schema.core", "0.36.0"],
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
                  ? [{ key, value: "0.36.0" }]
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
                { key, value: "0.36.0" },
                { key, value: "0.36.0" },
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
                  ? [{ key, value: "0.36.0" }]
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

    expect(settings).toEqual([{ key: "schema.core", value: "0.36.0" }]);
    expect(calls.at(-1)).toBe("marker");
  });

  it.each(["0.21.0", "0.29.0", "0.31.0", "0.36.0", "0.37.0", "0.38.0"])(
    "accepts known legacy version %s alongside a current Core marker",
    async (legacyVersion) => {
      const client = createSettingsMongoClient({
        "schema.core": "0.36.0",
        version: legacyVersion,
      });
      const migrator = createMongoMigrator(client);

      await expect(migrator.getVersion()).resolves.toBe("0.36.0");
      await expect(
        migrator.migrateToLatest({ mode: "from-schema" }),
      ).resolves.toMatchObject({ operations: [] });
    },
  );

  it.each(["0.39.0", "unknown"])(
    "rejects legacy MongoDB %s alongside a current Core marker before reading bundle data",
    async (legacyVersion) => {
      const client = createSettingsMongoClient({
        "schema.core": "0.36.0",
        version: legacyVersion,
      });
      const migrator = createMongoMigrator(client);
      const plugin = createInMemoryDatabasePlugin();
      const count = vi.spyOn(plugin, "count");
      const findMany = vi.spyOn(plugin, "findMany");
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
      { "schema.core": { version: "0.36.0" } },
      "schema.core",
    ],
    ["legacy marker alone", { version: { version: "0.38.0" } }, "version"],
    [
      "Core marker beside a valid legacy marker",
      { "schema.core": { version: "0.36.0" }, version: "0.38.0" },
      "schema.core",
    ],
    [
      "legacy marker beside a current Core marker",
      { "schema.core": "0.36.0", version: { version: "0.38.0" } },
      "version",
    ],
  ] as const)("rejects a corrupt %s", async (_case, values, key) => {
    const migrator = createMongoMigrator(createSettingsMongoClient(values));

    await expect(migrator.getVersion()).rejects.toThrow(
      `Invalid Hot Updater schema setting: ${key}`,
    );
  });

  it("ensures collections and indexes before updating the version", async () => {
    const calls: string[] = [];
    const backend: MongoMigrationBackend = {
      ensureCollections: async () => void calls.push("collections"),
      ensureIndexes: async () => void calls.push("indexes"),
      updateVersion: async () => void calls.push("version"),
    };

    await executeMongoMigration({ backend, updateSettings: true });

    expect(calls).toEqual(["collections", "indexes", "version"]);
  });
});
