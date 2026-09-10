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

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
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
  metadata: jsonb("metadata").notNull(),
  from_release_id: text("from_release_id"),
  from_bundle_id: text("from_bundle_id"),
  to_release_id: text("to_release_id"),
  to_bundle_id: text("to_bundle_id").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  channel: text("channel").notNull(),

  received_at_ms: integer("received_at_ms").notNull(),
});
const bundleEventHeads = pgTable("bundle_event_heads", {
  install_id: text("install_id").primaryKey(),
  id: text("id").notNull(),
  received_at_ms: integer("received_at_ms").notNull(),
  user_id: text("user_id"),
  platform: text("platform").notNull(),
  channel: text("channel").notNull(),
  type: text("type").notNull(),
  from_bundle_id: text("from_bundle_id"),
  to_bundle_id: text("to_bundle_id").notNull(),
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
  bundle_event_heads: bundleEventHeads,

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
  it("counts MySQL predicate overlap and nullable sources in one SQL snapshot", async () => {
    const db = new PGlite();
    await db.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
    const native = drizzle(db, { schema });
    const writer = drizzleAdapter({ db: native, provider: "postgresql" }).models
      .insights;
    const applied = createBundleEventRowFixture("711", 100);
    const overlap = { ...applied, from_bundle_id: applied.to_bundle_id };
    const unchanged = {
      ...createBundleEventRowFixture("712", 100),
      type: "UNCHANGED" as const,
      from_bundle_id: null,
      to_bundle_id: applied.to_bundle_id,
      metadata: { ...applied.metadata, update_strategy: null },
    };
    const count = drizzleAdapter({
      db: async () => native,
      schema,
      provider: "mysql",
      transaction: false,
    }).models.insights.countLatestEvents;
    const scope = {
      platform: "ios" as const,
      channel: "production",
      sinceMs: 0,
    };
    const from = {
      field: "from_bundle_id" as const,
      value: applied.to_bundle_id,
      types: ["UPDATE_APPLIED", "UNCHANGED"] as const,
    };
    const to = { ...from, field: "to_bundle_id" as const };
    try {
      await writer.recordEvent({ event: overlap });
      await writer.recordEvent({ event: unchanged });
      for (const bundle of [
        [from, to],
        [to, from],
        [to, to],
      ]) {
        await expect(count({ ...scope, bundle })).resolves.toBe(2);
      }
      await expect(count({ ...scope, bundle: [from] })).resolves.toBe(1);
      await expect(count(scope)).resolves.toBe(2);
    } finally {
      await db.close();
    }
  });
  it.each([undefined, false])(
    "keeps lazy Insights writes atomic with catalog transaction option %s",
    async (transaction) => {
      const db = new PGlite();
      await db.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
      const native = drizzle(db, { schema });
      const callbackTransaction = vi
        .spyOn(native, "transaction")
        .mockImplementation(() => {
          throw new Error("callback transactions are unavailable");
        });
      const plugin = drizzleAdapter({
        db: async () => native,
        provider: "postgresql",
        schema,
        transaction,
      });
      const previous = createBundleEventRowFixture("709", 100);
      const next = {
        ...createBundleEventRowFixture("710", 200),
        install_id: previous.install_id,
      };
      try {
        await plugin.models.insights.recordEvent({ event: previous });
        await db.exec(
          "alter table bundle_event_heads add constraint reject_head check (received_at_ms < 200)",
        );
        await expect(
          plugin.models.insights.recordEvent({ event: next }),
        ).rejects.toThrow();
        expect((await db.query("select id from bundle_events")).rows).toEqual([
          { id: previous.id },
        ]);
        await expect(
          plugin.models.insights.findLatestEvents({
            installId: previous.install_id,
          }),
        ).resolves.toEqual([previous]);
        await db.exec(
          "alter table bundle_event_heads drop constraint reject_head",
        );
        await plugin.models.insights.recordEvent({ event: next });
        await plugin.models.insights.recordEvent({
          event: { ...next, received_at_ms: 300, user_id: "incorrect-user" },
        });
        await expect(
          plugin.models.insights.findLatestEvents({
            installId: previous.install_id,
          }),
        ).resolves.toEqual([next]);
        expect(callbackTransaction).not.toHaveBeenCalled();
      } finally {
        await db.close();
      }
    },
  );
  it("rolls back a Bun SQLite event when its head cannot be written", async () => {
    const { stdout } = await promisify(execFile)(
      new URL("../../../../node_modules/.bin/bun", import.meta.url).pathname,
      [
        "-e",
        `
        import { Database } from "bun:sqlite";
        import { drizzle } from "drizzle-orm/bun-sqlite";
        import { drizzleAdapter } from "./src/adapters/drizzle.ts";
        import { createTableSql } from "./src/db/schema/sql.ts";
        import { createBundleEventRowFixture } from "../test-utils/src/databaseTestFixtures.ts";
        import * as schema from "../../examples-server/elysia-drizzle-libsql/hot-updater-schema.ts";
        const db = new Database(":memory:");
        db.exec(createTableSql("sqlite").join(";"));
        db.exec("create trigger reject_head before insert on bundle_event_heads begin select raise(abort, 'injected head failure'); end;");
        const plugin = drizzleAdapter({ db: drizzle(db, { schema }), provider: "sqlite" });
        const event = createBundleEventRowFixture("708", 100);
        const input = { event };
        let rejected = false;
        try { await plugin.models.insights.recordEvent(input); } catch { rejected = true; }
        if (!rejected || db.query("select count(*) as total from bundle_events").get().total !== 0) throw new Error("transaction failed to roll back");
        db.exec("drop trigger reject_head");
        await plugin.models.insights.recordEvent(input);
        await plugin.models.insights.recordEvent(input);
        if (db.query("select count(*) as total from bundle_events").get().total !== 1) throw new Error("retry did not commit exactly one report");
        const stored = db.query("select json_type(cast(metadata as text)) as kind from bundle_events").get();
        if (stored.kind !== "object") throw new Error("event metadata was double encoded");
        const latest = await plugin.models.insights.findLatestEvents({ installId: event.install_id });
        if (JSON.stringify(latest[0].metadata) !== JSON.stringify(event.metadata)) throw new Error("metadata did not round trip");
        db.close();
        console.log("atomic retry verified");
      `,
      ],
      { cwd: new URL("../..", import.meta.url).pathname },
    );
    expect(stdout).toContain("atomic retry verified");
  });
  it("keeps failed event inserts absent and permits retry", async () => {
    const db = new PGlite();
    await db.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
    await db.exec(
      "alter table bundle_events add constraint reject_event check (install_id <> 'install-701')",
    );
    const plugin = drizzleAdapter({
      db: drizzle(db, { schema }),
      provider: "postgresql",
    });
    const event = createBundleEventRowFixture("701", 100);
    const input = { event };
    try {
      await expect(plugin.models.insights.recordEvent(input)).rejects.toThrow();
      expect((await db.query("select id from bundle_events")).rows).toEqual([]);
      await db.exec("alter table bundle_events drop constraint reject_event");
      await plugin.models.insights.recordEvent(input);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([input.event]);
    } finally {
      await db.close();
    }
  });

  it("resolves the lazy database when recording an event", async () => {
    const getDB = vi.fn(() => {
      throw new DrizzleTestStateError();
    });
    const plugin = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
      schema,
    });
    const event = createBundleEventRowFixture("702", 100);
    await expect(
      plugin.models.insights.recordEvent({
        event,
      }),
    ).rejects.toThrow(DrizzleTestStateError);
    expect(getDB).toHaveBeenCalledOnce();
  });
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
