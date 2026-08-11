import { PGlite } from "@electric-sql/pglite";
import {
  boolean,
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
  should_force_update: boolean("should_force_update").notNull(),
  enabled: boolean("enabled").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull().default("production"),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: jsonb("metadata").notNull(),
  rollout_cohort_count: integer("rollout_cohort_count").notNull(),
  target_cohorts: jsonb("target_cohorts"),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri"),
});
const bundlePatches = pgTable("bundle_patches", {
  id: varchar("id", { length: 255 }).primaryKey(),
  bundle_id: text("bundle_id").notNull(),
  base_bundle_id: text("base_bundle_id").notNull(),
  base_file_hash: text("base_file_hash").notNull(),
  patch_file_hash: text("patch_file_hash").notNull(),
  patch_storage_uri: text("patch_storage_uri").notNull(),
  order_index: integer("order_index").notNull(),
});
const bundleEvents = pgTable("bundle_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  install_id: text("install_id").notNull(),
  user_id: text("user_id"),
  username: text("username"),
  from_bundle_id: text("from_bundle_id"),
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
const clientAccessKeys = pgTable("client_access_keys", {
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
  bundle_patches: bundlePatches,
  bundles,
  client_access_keys: clientAccessKeys,
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
      await expect(plugin.getChannels?.()).resolves.toEqual([]);
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

    expect(() => plugin.getChannels?.()).toThrow(
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

    expect(() => plugin.getChannels?.()).toThrow(
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

    expect(() => plugin.getChannels?.()).toThrow(
      'Drizzle schema is missing table "bundle_patches".',
    );
  });
});
