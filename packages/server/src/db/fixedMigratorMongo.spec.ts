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
      createIndex: vi.fn(async () => "created"),
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
    expect(modelCollection.createIndex).toHaveBeenCalledWith(
      { install_id: 1, received_at_ms: 1, id: 1 },
      {
        name: "bundle_events_latest_idx",
        collation: { locale: "simple" },
      },
    );
    expect(modelCollection.createIndex).toHaveBeenCalledWith(
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
    expect(modelCollection.createIndex).toHaveBeenCalledWith(
      {
        type: 1,
        platform: 1,
        channel: 1,
        to_bundle_id: 1,
        received_at_ms: 1,
        id: 1,
      },
      { name: "bundle_events_to_bundle_idx", collation: { locale: "simple" } },
    );
    expect(modelCollection.createIndex).toHaveBeenCalledWith(
      { user_id: 1, install_id: 1 },
      {
        name: "bundle_event_heads_user_idx",
        collation: { locale: "simple" },
      },
    );
    expect(modelCollection.createIndex).toHaveBeenCalledWith(
      { install_id: 1 },
      {
        name: "bundle_event_heads_install_id_idx",
        unique: true,
        collation: { locale: "simple" },
      },
    );
    expect(modelCollection.createIndex).toHaveBeenCalledWith(
      { platform: 1, channel: 1, received_at_ms: 1 },
      {
        name: "bundle_event_heads_scope_idx",
        collation: { locale: "simple" },
      },
    );
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
