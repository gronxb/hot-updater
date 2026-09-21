import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, SqliteDialect, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createKyselyMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { kyselyAdapter } from "./kysely";

describe.each(["postgresql", "sqlite"] as const)(
  "Kysely %s Insights heads",
  (provider) => {
    let db: Kysely<object>;
    let postgres: PGlite | undefined;
    let adapter: DatabaseAdapterWithCapabilities;

    beforeEach(async () => {
      if (provider === "postgresql") {
        postgres = new PGlite();
        db = new Kysely<object>({ dialect: new PGliteDialect(postgres) });
      } else {
        const sqlite = new DatabaseSync(":memory:");
        db = new Kysely<object>({
          dialect: new SqliteDialect({
            database: {
              close: () => sqlite.close(),
              prepare: (query) => {
                const statement = sqlite.prepare(query);
                return {
                  reader: statement.columns().length > 0,
                  all: (parameters) =>
                    statement.all(...(parameters as SqliteValue[])),
                  run: (parameters) => {
                    const result = statement.run(
                      ...(parameters as SqliteValue[]),
                    );
                    return {
                      changes: result.changes,
                      lastInsertRowid: result.lastInsertRowid,
                    };
                  },
                  iterate: (parameters) =>
                    statement.iterate(...(parameters as SqliteValue[])),
                };
              },
            },
          }),
        });
      }
      adapter = kyselyAdapter({ db, provider });
      await (
        await createKyselyMigrator({ db, provider }).migrateToLatest()
      ).execute();
    });

    afterEach(async () => {
      await db.destroy();
      await postgres?.close();
      postgres = undefined;
    });

    it("rolls back the canonical event when the head write fails and permits retry", async () => {
      const insights = adapter.models.insights;
      const previous = createBundleEventRowFixture("811", 100);
      const next = {
        ...createBundleEventRowFixture("812", 200),
        install_id: previous.install_id,
      };
      await insights.recordEvent({ event: previous });
      await sql`alter table bundle_event_heads rename to unavailable_heads`.execute(
        db,
      );

      await expect(insights.recordEvent({ event: next })).rejects.toThrow();
      expect(
        (await sql`select id from bundle_events order by id`.execute(db)).rows,
      ).toEqual([{ id: previous.id }]);

      await sql`alter table unavailable_heads rename to bundle_event_heads`.execute(
        db,
      );
      await expect(
        insights.findLatestEvents({ installId: previous.install_id }),
      ).resolves.toEqual([previous]);
      await insights.recordEvent({ event: next });
      await expect(
        insights.findLatestEvents({ installId: previous.install_id }),
      ).resolves.toEqual([next]);
    });

    it("keeps delayed and altered duplicate reports from replacing the canonical head", async () => {
      const insights = adapter.models.insights;
      const previous = {
        ...createBundleEventRowFixture("821", 100),
        user_id: "previous-user",
      };
      const newest = {
        ...createBundleEventRowFixture("823", 200),
        install_id: previous.install_id,
        user_id: "current-user",
        channel: "preview",
        metadata: { ...previous.metadata, device: { locale: "ko-KR" } },
      };
      const tied = {
        ...createBundleEventRowFixture("822", 200),
        install_id: previous.install_id,
      };
      await insights.recordEvent({ event: newest });
      await Promise.all([
        insights.recordEvent({ event: tied }),
        insights.recordEvent({ event: previous }),
      ]);
      await insights.recordEvent({
        event: {
          ...previous,
          install_id: "changed-retry-installation",
          user_id: "changed-retry-user",
          received_at_ms: 300,
        },
      });

      await expect(
        insights.findLatestEvents({ installId: previous.install_id }),
      ).resolves.toEqual([newest]);
      await expect(
        insights.findLatestEvents({ userId: "current-user", limit: 10 }),
      ).resolves.toEqual([newest]);
      await expect(
        insights.findLatestEvents({ userId: "previous-user", limit: 10 }),
      ).resolves.toEqual([]);
      await expect(
        insights.findLatestEvents({ installId: "changed-retry-installation" }),
      ).resolves.toEqual([]);
      await expect(
        insights.countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 0,
        }),
      ).resolves.toBe(0);
      await expect(
        insights.countLatestEvents({
          platform: "ios",
          channel: "preview",
          sinceMs: 0,
        }),
      ).resolves.toBe(1);
      expect(
        (await sql`select * from bundle_event_heads`.execute(db)).rows,
      ).toEqual([
        {
          install_id: newest.install_id,
          id: newest.id,
          received_at_ms: newest.received_at_ms,
          user_id: newest.user_id,
          platform: newest.platform,
          channel: newest.channel,
          type: newest.type,
          from_bundle_id: newest.from_bundle_id,
          to_bundle_id: newest.to_bundle_id,
          current_release_id: newest.to_release_id,
          app_version: newest.app_version,
        },
      ]);
    });

    it("maintains exact counters, merged users, scope rows, and latest-report distribution", async () => {
      const insights = adapter.models.insights;
      const first = createBundleEventRowFixture("831", 100);
      const second = createBundleEventRowFixture("832", 200);
      const recovery = createBundleEventRowFixture("833", 300);
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
          id: "00000000-0000-7000-8000-000000000834",
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
      await Promise.all(events.map((event) => insights.recordEvent({ event })));
      await insights.recordEvent({ event: events[3]! });

      const references = [releaseA, releaseB].map((releaseId) => ({
        releaseId,
        platform: "ios" as const,
        channel: "production",
      }));
      const lifetime = await insights.getReleaseActivity({
        releases: references,
      });
      expect(lifetime.data.map(({ metrics }) => metrics)).toEqual([
        { downloads: 0, launches: 2, failedLaunches: 0 },
        { downloads: 1, launches: 1, failedLaunches: 1 },
      ]);

      const period = await insights.getReleaseActivity({
        scope: { platform: "ios", channel: "production" },
        timeRange: { start: 0, end: 3_600_000 },
      });
      expect(period.data[0]?.metrics).toMatchObject({
        downloads: 1,
        launches: 3,
        failedLaunches: 1,
        uniqueUsers: 3,
        series: [{ startMs: 0, launches: 3, failedLaunches: 1 }],
      });

      const usage = await insights.getAppUsage({
        channel: "production",
        platform: "all",
        timeRange: { start: 0, end: 3_600_000 },
        intervalMs: 3_600_000,
      });
      expect(usage.activeInstallations).toBe(3);
      expect(usage.points).toEqual([{ startMs: 0, installations: 3 }]);
      expect(usage.bundleDistribution).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ releaseId: releaseA, installations: 2 }),
          expect.objectContaining({ releaseId: releaseB, installations: 1 }),
        ]),
      );
    });
  },
);
