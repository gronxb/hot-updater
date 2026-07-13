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

import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  DATABASE_ADAPTER_TEST_RESET_SQL,
  DATABASE_ADAPTER_TEST_SCHEMA_SQL,
} from "./databaseAdapterTestDatabase";
import { drizzleAdapter } from "./drizzle";

const channels = pgTable("channels", {
  id: varchar("id", { length: 255 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
});
const bundles = pgTable("bundles", {
  id: text("id").primaryKey(),
  platform: text("platform").notNull(),
  should_force_update: boolean("should_force_update").notNull(),
  enabled: boolean("enabled").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel_id: varchar("channel_id", { length: 255 }).notNull(),
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
const schema = { bundle_patches: bundlePatches, bundles, channels };

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

setupDatabaseAdapterTestSuite({
  name: "drizzleAdapter PostgreSQL",
  capabilities: { transaction: true },
  migrate: async () => {
    client = new PGlite();
    await client.exec(DATABASE_ADAPTER_TEST_SCHEMA_SQL);
    database = drizzle(client, { schema });
  },
  createAdapter: (): DatabaseAdapterWithCapabilities =>
    drizzleAdapter({ db: getDatabase(), provider: "postgresql" }),
  reset: async () => {
    await getClient().exec(DATABASE_ADAPTER_TEST_RESET_SQL);
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
    const adapter = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
      schema,
    });

    const generated = adapter.generateSchema?.("latest");

    expect(generated?.code).toContain("pgTable");
    expect(getDB).not.toHaveBeenCalled();
  });

  it("requires all three fixed table objects", () => {
    const incompleteSchema = { bundle_patches: bundlePatches, bundles };

    expect(() =>
      drizzleAdapter({
        db: () => getDatabase(),
        provider: "postgresql",
        schema: incompleteSchema,
      }),
    ).toThrow('Drizzle schema is missing table "channels".');
  });
});
