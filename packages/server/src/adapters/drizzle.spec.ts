import { PGlite } from "@electric-sql/pglite";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createHotUpdater } from "../index";
import {
  DATABASE_PLUGIN_TEST_RESET_SQL,
  DATABASE_PLUGIN_TEST_SCHEMA_SQL,
} from "./databasePluginTestDatabase";
import { drizzleAdapter } from "./drizzle";
import { schema } from "./drizzleTestSchema";

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
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: { type: "public" } })
        .handlers,
    ),
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
  it("maintains aggregate counters, recovered attribution, distinct users, and latest distribution", async () => {
    const db = new PGlite();
    await db.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
    const insights = drizzleAdapter({
      db: drizzle(db, { schema }),
      provider: "postgresql",
    }).models.insights;
    const first = createBundleEventRowFixture("720", 100);
    const second = createBundleEventRowFixture("721", 200);
    const recovery = createBundleEventRowFixture("722", 300);
    const releaseA = first.to_bundle_id;
    const releaseB = second.to_bundle_id;
    const events = [
      {
        ...first,
        type: "UPDATE_DOWNLOADED" as const,
        to_release_id: releaseB,
      },
      {
        ...first,
        id: createBundleEventRowFixture("723", 100).id,
        type: "UNCHANGED" as const,
        from_bundle_id: null,
        from_release_id: null,
        to_release_id: releaseA,
        metadata: { ...first.metadata, update_strategy: null },
      },
      { ...second, to_release_id: releaseB },
      {
        ...recovery,
        type: "RECOVERED" as const,
        from_release_id: releaseB,
        to_release_id: releaseA,
      },
    ];
    try {
      await Promise.all(events.map((event) => insights.recordEvent({ event })));
      await insights.recordEvent({ event: events[3]! });
      const lifetime = await insights.getReleaseActivity({
        releases: [releaseA, releaseB].map((releaseId) => ({
          releaseId,
          platform: "ios" as const,
          channel: "production",
        })),
      });
      expect(lifetime.data.map(({ metrics }) => metrics)).toEqual([
        { downloads: 0, launches: 2, failedLaunches: 0 },
        { downloads: 1, launches: 1, failedLaunches: 1 },
      ]);
      const activity = await insights.getReleaseActivity({
        scope: { platform: "ios", channel: "production" },
        timeRange: { start: 0, end: 3_600_000 },
      });
      expect(activity.data[0]?.metrics).toMatchObject({
        downloads: 1,
        launches: 3,
        failedLaunches: 1,
        uniqueUsers: 3,
      });
      const usage = await insights.getAppUsage({
        channel: "production",
        platform: "all",
        timeRange: { start: 0, end: 3_600_000 },
        intervalMs: 3_600_000,
      });
      expect(usage.activeInstallations).toBe(3);
      expect(usage.bundleDistribution).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ releaseId: releaseA, installations: 2 }),
          expect.objectContaining({ releaseId: releaseB, installations: 1 }),
        ]),
      );
    } finally {
      await db.close();
    }
  });

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
    "uses a native Insights transaction with catalog transaction option %s",
    async (transaction) => {
      const db = new PGlite();
      await db.exec(DATABASE_PLUGIN_TEST_SCHEMA_SQL);
      const native = drizzle(db, { schema });
      const callbackTransaction = vi.spyOn(native, "transaction");
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
        expect(callbackTransaction).toHaveBeenCalled();
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
    const incompleteSchema = { bundles: schema.bundles };
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
