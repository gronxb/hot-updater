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

import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import {
  DATABASE_ADAPTER_TEST_RESET_SQL,
  DATABASE_ADAPTER_TEST_SCHEMA_SQL,
} from "./databaseAdapterTestDatabase";
import { drizzleAdapter } from "./drizzle";

const bundleChannels = pgTable("bundle_channels", {
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
  channel: text("channel").notNull().default("production"),
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
const bundleEvents = pgTable("bundle_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  install_id: text("install_id").notNull(),
  user_id: text("user_id"),
  username: text("username"),
  from_bundle_id: text("from_bundle_id").notNull(),
  to_bundle_id: text("to_bundle_id").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  channel: text("channel").notNull(),
  cohort: text("cohort").notNull(),
  update_strategy: text("update_strategy").notNull(),
  fingerprint_hash: text("fingerprint_hash"),
  sdk_version: text("sdk_version"),
  received_at_ms: doublePrecision("received_at_ms").notNull(),
});
const schema = {
  bundle_events: bundleEvents,
  bundle_patches: bundlePatches,
  bundles,
  bundle_channels: bundleChannels,
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

setupDatabaseAdapterTestSuite({
  name: "drizzleAdapter PostgreSQL",
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

const createBundleEventRow = (
  id: string,
  installId: string,
  receivedAtMs: number,
) => ({
  id,
  type: "UPDATE_APPLIED" as const,
  install_id: installId,
  user_id: null,
  username: null,
  from_bundle_id: `from-${installId}`,
  to_bundle_id: `to-${installId}`,
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  update_strategy: "appVersion" as const,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

describe("drizzleAdapter schema requirements", () => {
  it("supports bundle event reads through a lazy database", async () => {
    const localClient = new PGlite();
    await localClient.exec(DATABASE_ADAPTER_TEST_SCHEMA_SQL);
    const localDatabase = drizzle(localClient, { schema });
    const resolveDatabase = vi.fn(async () => localDatabase);
    const adapter = drizzleAdapter({
      db: resolveDatabase,
      provider: "postgresql",
      schema,
    });

    try {
      await adapter.create({
        model: "bundle_events",
        data: createBundleEventRow("lazy-event", "lazy-install", 100),
      });

      await expect(
        adapter.findMany({ model: "bundle_events" }),
      ).resolves.toMatchObject([{ id: "lazy-event" }]);
      expect(resolveDatabase).toHaveBeenCalledOnce();
    } finally {
      await localClient.close();
    }
  });

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

  it("requires all four fixed table objects", () => {
    const incompleteSchema = {
      bundle_events: bundleEvents,
      bundle_patches: bundlePatches,
      bundles,
    };

    expect(() =>
      drizzleAdapter({
        db: () => getDatabase(),
        provider: "postgresql",
        schema: incompleteSchema,
      }),
    ).toThrow('Drizzle schema is missing table "bundle_channels".');
  });
});

describe("drizzleAdapter bundle_events distinct semantics", () => {
  it("counts distinct installs and keeps the latest row per install", async () => {
    const localClient = new PGlite();
    await localClient.exec(DATABASE_ADAPTER_TEST_SCHEMA_SQL);
    const localDatabase = drizzle(localClient, { schema });
    const adapter = drizzleAdapter({
      db: localDatabase,
      provider: "postgresql",
    });

    try {
      await adapter.create({
        model: "bundle_events",
        data: createBundleEventRow("event-a-1", "install-a", 100),
      });
      await adapter.create({
        model: "bundle_events",
        data: createBundleEventRow("event-a-2", "install-a", 200),
      });
      await adapter.create({
        model: "bundle_events",
        data: createBundleEventRow("event-b-1", "install-b", 150),
      });
      await adapter.create({
        model: "bundle_events",
        data: createBundleEventRow("event-b-2", "install-b", 150),
      });

      await expect(
        adapter.count({ model: "bundle_events", distinct: ["install_id"] }),
      ).resolves.toBe(2);
      await expect(
        adapter.findMany({
          model: "bundle_events",
          distinctOn: { fields: ["install_id"] },
          orderBy: [
            { field: "install_id", direction: "asc" },
            { field: "received_at_ms", direction: "desc" },
            { field: "id", direction: "desc" },
          ],
        }),
      ).resolves.toMatchObject([
        { id: "event-a-2", install_id: "install-a", received_at_ms: 200 },
        { id: "event-b-2", install_id: "install-b", received_at_ms: 150 },
      ]);
    } finally {
      await localClient.close();
    }
  });
  it("honors explicit null ordering for bundle event queries", async () => {
    const localClient = new PGlite();
    await localClient.exec(DATABASE_ADAPTER_TEST_SCHEMA_SQL);
    const localDatabase = drizzle(localClient, { schema });
    const adapter = drizzleAdapter({
      db: localDatabase,
      provider: "postgresql",
    });

    try {
      await adapter.create({
        model: "bundle_events",
        data: createBundleEventRow("event-null", "install-a", 100),
      });
      await adapter.create({
        model: "bundle_events",
        data: {
          ...createBundleEventRow("event-user", "install-b", 200),
          user_id: "user-123",
        },
      });

      await expect(
        adapter.findMany({
          model: "bundle_events",
          orderBy: [
            { field: "user_id", direction: "asc", nulls: "first" },
            { field: "id", direction: "asc" },
          ],
        }),
      ).resolves.toMatchObject([
        { id: "event-null", user_id: null },
        { id: "event-user", user_id: "user-123" },
      ]);
    } finally {
      await localClient.close();
    }
  });
});
