import { MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { createDatabasePluginCore } from "./databasePluginCore";
import { createMongoMigrator } from "./fixedMigrator";
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
  it("creates the current schema from an empty database", async () => {
    const settings = new Map<string, unknown>();
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
    const command = vi.fn(
      async (_input: Record<string, unknown>): Promise<void> => undefined,
    );
    const database = {
      command,
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
    expect(settings.get("schema.core")).toBe(HOT_UPDATER_SCHEMA_VERSION);
    const commands = command.mock.calls.map(([input]) => input);
    expect(commands.find(({ collMod }) => collMod === "bundles")).toMatchObject(
      {
        validationAction: "error",
        validationLevel: "strict",
        validator: {
          $and: [
            {
              $jsonSchema: {
                properties: {
                  archive_byte_size: {
                    bsonType: ["double", "int", "long"],
                    maximum: Number.MAX_SAFE_INTEGER,
                    minimum: 0,
                  },
                },
                required: expect.arrayContaining(["archive_byte_size"]),
              },
            },
            {
              $expr: {
                $eq: [{ $trunc: "$archive_byte_size" }, "$archive_byte_size"],
              },
            },
          ],
        },
      },
    );
    expect(
      commands.find(({ collMod }) => collMod === "bundle_patches"),
    ).toMatchObject({
      validationAction: "error",
      validationLevel: "strict",
      validator: {
        $and: [
          {
            $jsonSchema: {
              properties: {
                byte_size: {
                  bsonType: ["double", "int", "long"],
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                },
              },
              required: expect.arrayContaining(["byte_size"]),
            },
          },
          {
            $expr: {
              $and: expect.arrayContaining([
                {
                  $eq: [{ $trunc: "$byte_size" }, "$byte_size"],
                },
              ]),
            },
          },
        ],
      },
    });
  });

  it("is a no-op when schema.core is current", async () => {
    const client = createSettingsMongoClient({
      "schema.core": HOT_UPDATER_SCHEMA_VERSION,
    });
    const migrator = createMongoMigrator(client);

    await expect(migrator.getVersion()).resolves.toBe(
      HOT_UPDATER_SCHEMA_VERSION,
    );
    await expect(
      migrator.migrateToLatest({ mode: "from-schema" }),
    ).resolves.toMatchObject({ operations: [] });
  });

  it("ignores a leftover version marker when schema.core is current", async () => {
    const client = createSettingsMongoClient({
      "schema.core": HOT_UPDATER_SCHEMA_VERSION,
      version: "0.36.0",
    });
    const migrator = createMongoMigrator(client);

    await expect(migrator.getVersion()).resolves.toBe(
      HOT_UPDATER_SCHEMA_VERSION,
    );
    await expect(
      migrator.migrateToLatest({ mode: "from-schema" }),
    ).resolves.toMatchObject({ operations: [] });
  });

  it("rejects in-place upgrade from a v0 schema marker", async () => {
    const client = createSettingsMongoClient({ "schema.core": "0.38.0" });
    const migrator = createMongoMigrator(client);

    await expect(
      migrator.migrateToLatest({ mode: "from-schema" }),
    ).rejects.toThrow("Hot Updater v1 cannot migrate schema 0.38.0");
  });

  it("upgrades 1.0.0 by rebuilding only Insights indexes with binary collation", async () => {
    let version = "1.0.0";
    const touchedCollections: string[] = [];
    const createIndex = vi.fn(async () => "created");
    const dropIndex = vi.fn(async () => undefined);
    const createCollection = vi.fn();
    const command = vi.fn();
    const client = {
      db: () => ({
        createCollection,
        command,
        collection: (name: string) =>
          name === "private_hot_updater_settings"
            ? {
                find: ({ key }: { key: string }) => ({
                  limit: () => ({
                    toArray: async () =>
                      key === "schema.core" ? [{ key, value: version }] : [],
                  }),
                }),
                listIndexes: () => ({
                  toArray: async () => [{ key: { key: 1 }, unique: true }],
                }),
                updateOne: async (
                  _filter: unknown,
                  update: { $set: { value: string } },
                ) => {
                  version = update.$set.value;
                },
              }
            : (() => {
                touchedCollections.push(name);
                return {
                  createIndex,
                  dropIndex,
                  listIndexes: () => ({
                    toArray: async () =>
                      name === "bundle_installations"
                        ? [
                            {
                              name: "bundle_installations_user_id_idx",
                              key: { user_id: 1, install_id: 1 },
                              collation: { locale: "en" },
                            },
                          ]
                        : [],
                  }),
                };
              })(),
      }),
    } as unknown as MongoClient;
    const plan = await createMongoMigrator(client).migrateToLatest();
    await plan.execute();
    expect(version).toBe(HOT_UPDATER_SCHEMA_VERSION);
    expect(touchedCollections).toEqual([
      "bundle_events",
      "bundle_installations",
    ]);
    expect(createCollection).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(dropIndex).toHaveBeenCalledWith("bundle_installations_user_id_idx");
    expect(createIndex).toHaveBeenCalledWith(
      {
        type: 1,
        platform: 1,
        channel: 1,
        from_bundle_id: 1,
        received_at_ms: 1,
        id: 1,
      },
      {
        name: "bundle_events_from_bundle_idx",
        collation: { locale: "simple" },
      },
    );
  });

  it("blocks v0 schema readiness before reading bundle data", async () => {
    const client = createSettingsMongoClient({ version: "0.36.0" });
    const migrator = createMongoMigrator(client);
    const plugin = createInMemoryDatabasePlugin();
    const count = vi.spyOn(plugin.models.bundles, "count");
    const findMany = vi.spyOn(plugin.models.bundles, "findMany");
    const core = createDatabasePluginCore(plugin, async () => null, {
      beforeOperation: createSchemaReadinessChecker(
        "v0-mongodb",
        () => migrator,
      ),
    });

    await expect(core.api.getBundles({ limit: 1 })).rejects.toThrow(
      "Hot Updater v1 cannot migrate schema 0.36.0",
    );
    expect(count).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
