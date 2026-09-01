import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { databaseFields } from "@hot-updater/plugin-core/internal";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  migratePostgresInsightsLive,
  migratePostgresInsightsSource,
} from "./db";
import { postgres } from "./postgres";
import {
  createPostgresInsightsLivePages,
  createPostgresInsightsLiveTools,
  POSTGRES_INSIGHTS_LIVE_TABLE,
  postgresInsightsInstallKey,
} from "./postgresInsightsLive";
import {
  createPostgresInsightsSourceTools,
  postgresEventSourceShard,
} from "./postgresInsightsSource";
import type { Database } from "./types";

describe("PostgreSQL live installation projection", () => {
  let client: PGlite;
  let db: Kysely<Database>;
  let queries: string[];

  const event = (suffix: string, installId: string, receivedAtMs: number) => ({
    ...createBundleEventRowFixture(suffix, receivedAtMs),
    install_id: installId,
  });
  const insertLegacy = async (
    rows: readonly ReturnType<typeof event>[],
  ): Promise<void> => {
    if (rows.length > 0)
      await db.insertInto("bundle_events").values(rows).execute();
  };
  const prepareSource = async (): Promise<void> => {
    await migratePostgresInsightsSource(db);
    const source = createPostgresInsightsSourceTools(db);
    for (let step = 0; step < 100; step++) {
      const result = await source.backfillStep(2);
      if (result.ready) return;
    }
    throw new Error("source fixture did not become ready");
  };
  const prepareLive = async (limit = 2): Promise<void> => {
    await migratePostgresInsightsLive(db);
    const live = createPostgresInsightsLiveTools(db);
    for (let step = 0; step < 100; step++) {
      const result = await live.backfillStep(limit);
      if (result.ready) return;
    }
    throw new Error("live fixture did not become ready");
  };

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    queries = [];
    db = new Kysely<Database>({
      dialect: new PGliteDialect(client),
      log(event) {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("requires the source boundary, fences an omitted marker, and backfills one latest row per installation", async () => {
    const first = event("1", "same", 100);
    const tiedNewer = event("2", "same", 100);
    const future = event("3", `future-${"x".repeat(900)}`, 9_000_000_000_000);
    await insertLegacy([first, tiedNewer, future]);

    await expect(migratePostgresInsightsLive(db)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await prepareSource();
    await migratePostgresInsightsLive(db);
    const pages = createPostgresInsightsLivePages(db);
    await expect(
      pages.pageAll({ kind: "all", limit: 2 }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });

    const unfenced = event("4", "old-writer", 4);
    await expect(
      sql`insert into bundle_events
        (${sql.join(databaseFields.bundle_events.map((field) => sql.ref(field)))},
          insights_source_shard,insights_source_seq)
        values (${sql.join(databaseFields.bundle_events.map((field) => unfenced[field]))},
          ${postgresEventSourceShard(unfenced.id)},9999)`.execute(db),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "bundle_events_live_required",
    });

    await prepareLive(1);
    const expected = [tiedNewer, future].sort((left, right) =>
      Buffer.compare(
        postgresInsightsInstallKey(left.install_id),
        postgresInsightsInstallKey(right.install_id),
      ),
    );
    const firstPage = await pages.pageAll({ kind: "all", limit: 1 });
    expect(firstPage.state).toBe("ready");
    if (firstPage.state !== "ready") throw new Error("expected ready page");
    expect(firstPage.consistency).toBe("live");
    if (firstPage.consistency !== "live") throw new Error("expected live page");
    expect(firstPage.observedAtMs).toBeLessThan(future.received_at_ms);
    expect(firstPage.rows).toEqual([
      expect.objectContaining({ id: expected[0]!.id }),
    ]);
    expect(Object.keys(firstPage.rows[0]!).sort()).toEqual(
      [
        "app_version",
        "channel",
        "cohort",
        "id",
        "install_id",
        "platform",
        "received_at_ms",
        "to_bundle_id",
        "type",
        "user_id",
        "username",
      ].sort(),
    );
    const secondPage = await pages.pageAll({
      kind: "all",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage).toMatchObject({
      state: "ready",
      consistency: "live",
      rows: [expect.objectContaining({ id: expected[1]!.id })],
      nextCursor: null,
    });
    expect(
      await sql<{
        count: string;
      }>`select count(*)::text count from bundle_events
        where insights_live_version=1`.execute(db),
    ).toMatchObject({ rows: [{ count: "3" }] });
    const stored = await sql<{ event: object }>`select event from
      ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)} order by install_key`.execute(
      db,
    );
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows)
      expect(Object.keys(row.event).sort()).toEqual(
        [...databaseFields.bundle_events].sort(),
      );
  });

  it("updates raw, committed source, and latest projection atomically for direct appends", async () => {
    await prepareSource();
    await prepareLive();
    const dialect = new PGliteDialect(client);
    const plugin = postgres({ dialect });
    const newest = event("10", "hot", 20);
    const older = event("11", "hot", 10);
    await plugin.models.insights.append(newest);
    await plugin.models.insights.append(older);
    const pages = createPostgresInsightsLivePages(db);
    await expect(
      pages.pageAll({ kind: "all", limit: 10 }),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: newest.id })],
    });

    const shard = postgresEventSourceShard(newest.id);
    const beforeDuplicate = await sql<{ value: string }>`select
      committed_seq::text value from private_hot_updater_insights_source_clocks
      where shard=${shard}`.execute(db);
    await expect(plugin.models.insights.append(newest)).rejects.toMatchObject({
      code: "23505",
    });
    const afterDuplicate = await sql<{ value: string }>`select
      committed_seq::text value from private_hot_updater_insights_source_clocks
      where shard=${shard}`.execute(db);
    expect(afterDuplicate.rows).toEqual(beforeDuplicate.rows);

    await plugin.dispose?.();
  });

  it("rolls back source and raw writes when a stored digest collides with another full identity", async () => {
    await prepareSource();
    await prepareLive();
    const victim = event("20", "victim", 20);
    const other = event("21", "other", 10);
    await sql`insert into ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
      (install_key,install_id,event_id,received_at_ms,event) values
      (${postgresInsightsInstallKey(victim.install_id)},${other.install_id},
        ${other.id}::uuid,${other.received_at_ms},${JSON.stringify(other)}::jsonb)`.execute(
      db,
    );
    const shard = postgresEventSourceShard(victim.id);
    const before = await sql<{ value: string }>`select committed_seq::text value
      from private_hot_updater_insights_source_clocks where shard=${shard}`.execute(
      db,
    );
    const plugin = postgres({ dialect: new PGliteDialect(client) });
    await expect(plugin.models.insights.append(victim)).rejects.toMatchObject({
      code: "23502",
    });
    expect(
      await sql<{
        count: string;
      }>`select count(*)::text count from bundle_events
        where id=${victim.id}::uuid`.execute(db),
    ).toMatchObject({ rows: [{ count: "0" }] });
    expect(
      await sql<{ value: string }>`select committed_seq::text value
        from private_hot_updater_insights_source_clocks where shard=${shard}`.execute(
        db,
      ),
    ).toMatchObject({ rows: before.rows });
    await plugin.dispose?.();
  });

  it("keeps the backfill checkpoint and marker unchanged on corrupt identity", async () => {
    const victim = event("30", "victim", 30);
    await insertLegacy([victim]);
    await prepareSource();
    await migratePostgresInsightsLive(db);
    const other = event("31", "other", 31);
    await sql`insert into ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
      (install_key,install_id,event_id,received_at_ms,event) values
      (${postgresInsightsInstallKey(victim.install_id)},${other.install_id},
        ${other.id}::uuid,${other.received_at_ms},${JSON.stringify(other)}::jsonb)`.execute(
      db,
    );
    const live = createPostgresInsightsLiveTools(db);
    expect(await live.backfillStep(1)).toEqual({ ready: false, processed: 0 });
    const before = await sql<{
      initialized: boolean;
      ready: boolean;
      upper_id: string | null;
      after_id: string | null;
    }>`select initialized,ready,upper_id,after_id
      from private_hot_updater_insights_live_state`.execute(db);
    await expect(live.backfillStep(1)).rejects.toMatchObject({
      code: "invalid-result",
    });
    expect(
      await sql`select initialized,ready,failed,failure,upper_id,after_id
        from private_hot_updater_insights_live_state`.execute(db),
    ).toMatchObject({
      rows: [
        {
          ...before.rows[0],
          failed: true,
          failure: "storage:invalid-result",
        },
      ],
    });
    expect(
      await sql<{ marker: number | null }>`select insights_live_version marker
        from bundle_events where id=${victim.id}::uuid`.execute(db),
    ).toMatchObject({ rows: [{ marker: null }] });
    await expect(live.backfillStep(1)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
  });

  it("rejects malformed cursors before storage and refuses malformed layout keys before reading rows", async () => {
    await prepareSource();
    await prepareLive();
    const pages = createPostgresInsightsLivePages(db);
    await sql`drop table ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)} cascade`.execute(
      db,
    );
    await expect(
      pages.pageAll({ kind: "all", limit: 1, cursor: "not-json" }),
    ).rejects.toMatchObject({ code: "invalid-query" });

    await db.destroy();
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    queries = [];
    db = new Kysely<Database>({
      dialect: new PGliteDialect(client),
      log(event) {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
    await prepareSource();
    await prepareLive();
    await sql`alter table ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
      drop constraint private_hot_updater_insights_live_installations_pkey`.execute(
      db,
    );
    await sql`create unique index private_hot_updater_insights_live_installations_pkey
      on ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)} (install_key desc)`.execute(
      db,
    );
    queries = [];
    await expect(
      createPostgresInsightsLivePages(db).pageAll({ kind: "all", limit: 1 }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/select\s+encode\(live\.install_key/i);
    await sql`drop index private_hot_updater_insights_live_installations_pkey`.execute(
      db,
    );
    await sql`alter table ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
      add primary key (install_key)`.execute(db);
    await sql`alter table private_hot_updater_insights_live_state
      drop constraint private_hot_updater_insights_live_state_pkey`.execute(db);
    queries = [];
    await expect(
      createPostgresInsightsLivePages(db).pageAll({ kind: "all", limit: 1 }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/select\s+encode\(live\.install_key/i);
  });
});
