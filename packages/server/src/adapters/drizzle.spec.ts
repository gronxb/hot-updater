import { PGlite } from "@electric-sql/pglite";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  varchar,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";

import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  DATABASE_PLUGIN_TEST_RESET_SQL,
  DATABASE_PLUGIN_TEST_SCHEMA_SQL,
} from "./databasePluginTestDatabase";
import { drizzleAdapter } from "./drizzle";

const bundles = pgTable("bundles", {
  id: text("id").primaryKey(),
  platform: text("platform").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  storage_uri: text("storage_uri").notNull(),
  archive_byte_size: doublePrecision("archive_byte_size").notNull(),
  metadata: jsonb("metadata").notNull(),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri"),
});
const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
});
const releases = pgTable("releases", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  scope_key: text("scope_key").notNull(),
  channel_id: text("channel_id").notNull(),
  platform: text("platform").notNull(),
  kind: text("kind").notNull(),
  bundle_id: text("bundle_id"),
  strategy: text("strategy").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  enabled: boolean("enabled").notNull(),
  should_force_update: boolean("should_force_update").notNull(),
  message: text("message"),
  rollout_cohort_count: integer("rollout_cohort_count").notNull(),
  target_cohorts: jsonb("target_cohorts").notNull(),
  operation: text("operation").notNull(),
  source_release_id: text("source_release_id"),
  created_at_ms: integer("created_at_ms").notNull(),
  updated_at_ms: integer("updated_at_ms").notNull(),
});
const releaseCatalogs = pgTable("release_catalogs", {
  scope_key: text("scope_key").primaryKey(),
  catalog_id: text("catalog_id").notNull(),
  strategy: text("strategy").notNull(),
  channel_id: text("channel_id").notNull(),
  channel_key: text("channel_key").notNull(),
  platform: text("platform").notNull(),
  fingerprint_hash: text("fingerprint_hash"),
  generation: integer("generation").notNull(),
  payload: text("payload").notNull(),
  catalog_hash: text("catalog_hash").notNull(),
  byte_size: integer("byte_size").notNull(),
  is_tombstone: boolean("is_tombstone").notNull(),
  updated_at_ms: integer("updated_at_ms").notNull(),
});
const bundlePatches = pgTable("bundle_patches", {
  id: varchar("id", { length: 255 }).primaryKey(),
  bundle_id: text("bundle_id").notNull(),
  base_bundle_id: text("base_bundle_id").notNull(),
  base_file_hash: text("base_file_hash").notNull(),
  patch_file_hash: text("patch_file_hash").notNull(),
  patch_storage_uri: text("patch_storage_uri").notNull(),
  byte_size: doublePrecision("byte_size").notNull(),
  order_index: integer("order_index").notNull(),
});
const bundleEvents = pgTable("bundle_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  install_id: text("install_id").notNull(),
  user_id: text("user_id"),
  username: text("username"),
  from_release_id: text("from_release_id"),
  from_bundle_id: text("from_bundle_id"),
  to_release_id: text("to_release_id"),
  to_bundle_id: text("to_bundle_id").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  channel: text("channel").notNull(),
  cohort: text("cohort").notNull(),
  update_strategy: text("update_strategy"),
  fingerprint_hash: text("fingerprint_hash"),
  sdk_version: text("sdk_version"),
  received_at_ms: integer("received_at_ms").notNull(),
});
const bundleInstallations = pgTable("bundle_installations", {
  install_id: varchar("install_id", { length: 255 }).primaryKey(),
  id: text("id").notNull(),
  user_id: text("user_id"),
  username: text("username"),
  to_bundle_id: text("to_bundle_id").notNull(),
  type: text("type").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  channel: text("channel").notNull(),
  cohort: text("cohort").notNull(),
  received_at_ms: integer("received_at_ms").notNull(),
});
const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  hash: text("hash").notNull().unique(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  role: text("role").notNull(),
  created_at_ms: integer("created_at_ms").notNull(),
  revoked_at_ms: integer("revoked_at_ms"),
});
const schema = {
  bundle_events: bundleEvents,
  bundle_installations: bundleInstallations,
  bundle_patches: bundlePatches,
  bundles,
  channels,
  api_keys: apiKeys,
  release_catalogs: releaseCatalogs,
  releases,
};

class DrizzleTestStateError extends Error {
  readonly name = "DrizzleTestStateError";
}

let client: PGlite | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

const getClient = (): PGlite => {
  if (client === undefined) throw new DrizzleTestStateError();
  return client;
};

const getDatabase = (): ReturnType<typeof drizzle<typeof schema>> => {
  if (database === undefined) throw new DrizzleTestStateError();
  return database;
};

setupDatabasePluginTestSuite({
  name: "drizzleAdapter PostgreSQL",
  migrate: async () => {
    client = new PGlite();
    await client.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
    database = drizzle(client, { schema });
  },
  createPlugin: (): DatabaseAdapterWithCapabilities =>
    drizzleAdapter({ db: getDatabase(), provider: "postgresql" }),
  reset: async () => {
    await getClient().exec(DATABASE_PLUGIN_TEST_RESET_SQL);
  },
  dispose: async () => {
    await getClient().close();
    database = undefined;
    client = undefined;
  },
});

describe("drizzleAdapter schema requirements", () => {
  it("does not resolve a lazy database while generating a schema", () => {
    const getDB = vi.fn(() => {
      throw new DrizzleTestStateError();
    });
    const plugin = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
      schema,
    });

    const generated = plugin.generateSchema?.("latest");

    expect(generated?.code).toContain("pgTable");
    expect(getDB).not.toHaveBeenCalled();
  });

  it("resolves a lazy database on the first database operation", async () => {
    const lazyClient = new PGlite();
    await lazyClient.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
    const lazyDatabase = drizzle(lazyClient, { schema });
    const getDB = vi.fn(async () => lazyDatabase);
    const plugin = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
      schema,
    });

    try {
      expect(getDB).not.toHaveBeenCalled();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
      expect(getDB).toHaveBeenCalledOnce();
    } finally {
      await lazyClient.close();
    }
  });

  it("rejects a lazy database without a schema on first use", () => {
    const getDB = vi.fn(() => {
      throw new DrizzleTestStateError();
    });
    const plugin = drizzleAdapter({ db: getDB, provider: "postgresql" });

    expect(() => plugin.models.channels.list({})).toThrow(
      "[hot-updater] Drizzle adapter requires schema when db is lazy.",
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("rejects an invalid lazy database schema on first use", () => {
    const getDB = vi.fn(() => {
      throw new DrizzleTestStateError();
    });
    const plugin = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
      schema: { ...schema, bundles: null },
    });

    expect(() => plugin.models.channels.list({})).toThrow(
      '[hot-updater] Drizzle schema table "bundles" is invalid.',
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("requires all fixed table objects on first use", () => {
    const incompleteSchema = { bundles };
    const plugin = drizzleAdapter({
      db: () => getDatabase(),
      provider: "postgresql",
      schema: incompleteSchema,
    });

    expect(() => plugin.models.channels.list({})).toThrow(
      'Drizzle schema is missing table "bundle_patches".',
    );
  });
});
