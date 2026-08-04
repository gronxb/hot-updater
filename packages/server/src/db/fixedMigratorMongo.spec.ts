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
  values: Readonly<Record<string, string>>,
): MongoClient {
  const client = new MongoClient("mongodb://127.0.0.1");
  const database = client.db("hot_updater_migration_test");
  const collection = database.collection("private_hot_updater_settings");
  vi.spyOn(collection, "findOne").mockImplementation(async ({ key }) => {
    const value = typeof key === "string" ? values[key] : undefined;
    return value === undefined ? null : { key, value };
  });
  vi.spyOn(client, "db").mockReturnValue(database);
  vi.spyOn(database, "collection").mockReturnValue(collection);
  return client;
}

describe("MongoDB migration", () => {
  it.each(["0.37.0", "0.38.0"])(
    "adopts legacy composite version %s as Core 0.36",
    async (legacyVersion) => {
      const findOne = vi.fn(async ({ key }: { readonly key: string }) =>
        key === "version" ? { key, value: legacyVersion } : null,
      );
      const client = {
        db: () => ({ collection: () => ({ findOne }) }),
      } as unknown as MongoClient;

      await expect(createMongoMigrator(client).getVersion()).resolves.toBe(
        "0.36.0",
      );
      expect(findOne).toHaveBeenCalledWith({ key: "schema.core" });
      expect(findOne).toHaveBeenCalledWith({ key: "version" });
    },
  );

  it("records Core readiness without rewriting legacy settings", async () => {
    const settings = new Map<string, unknown>([["version", "0.38.0"]]);
    const settingsCollection = {
      findOne: async ({ key }: { readonly key: string }) => {
        const value = settings.get(key);
        return value === undefined ? null : { key, value };
      },
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

    expect(settings).toEqual(
      new Map([
        ["version", "0.38.0"],
        ["schema.core", "0.36.0"],
      ]),
    );
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
