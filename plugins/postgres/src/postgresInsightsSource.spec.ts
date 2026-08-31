import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  migratePostgresInsightsLive,
  migratePostgresInsightsSource,
} from "./db";
import { postgres } from "./postgres";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import {
  createPostgresInsightsSourceTools,
  postgresEventSourceShard,
} from "./postgresInsightsSource";
import type { Database } from "./types";

type ExplainPlan = {
  "Node Type": string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Index Name"?: string;
  "Rows Removed by Filter"?: number;
  Plans?: ExplainPlan[];
};
const assertBoundedIndexPlan = (
  plan: ExplainPlan,
  index: string,
  limit: number,
) => {
  const nodes: ExplainPlan[] = [];
  const visit = (node: ExplainPlan) => {
    nodes.push(node);
    node.Plans?.forEach(visit);
  };
  visit(plan);
  expect(nodes.some((node) => node["Index Name"] === index)).toBe(true);
  for (const node of nodes) {
    expect(node["Node Type"]).not.toMatch(/Seq Scan|Sort/);
    expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(
      limit,
    );
    expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
  }
};

describe("PostgreSQL committed Insights source", () => {
  let client: PGlite;
  let db: Kysely<Database>;
  let plugin: ReturnType<typeof postgres>;
  let source: ReturnType<typeof createPostgresInsightsSourceTools>;
  const event = (n: number, time = n) =>
    createBundleEventRowFixture(String(n), time);
  const clocks = async () =>
    (
      await client.query(
        "select shard, committed_seq::text from private_hot_updater_insights_source_clocks order by shard",
      )
    ).rows;
  const state = async () =>
    (
      await client.query<{ source_id: string; upper_id: string | null }>(
        "select * from private_hot_updater_insights_source_state",
      )
    ).rows[0];
  const ready = async () => {
    await migratePostgresInsightsSource(db);
    expect(await source.backfillStep(2)).toEqual({ ready: true, processed: 0 });
    await migratePostgresInsightsLive(db);
    expect(await createPostgresInsightsLiveTools(db).backfillStep(2)).toEqual({
      ready: true,
      processed: 0,
    });
  };

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    db = new Kysely<Database>({ dialect: new PGliteDialect(client) });
    plugin = postgres({ dialect: new PGliteDialect(client) });
    source = createPostgresInsightsSourceTools(db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await plugin.dispose?.();
  });

  it("requires explicit migration, rejects premature capture and keeps source identity across migration retries", async () => {
    await expect(plugin.models.insights.append(event(1))).rejects.toMatchObject(
      { code: "42P01" },
    );
    expect(
      (await client.query("select id from bundle_events")).rows,
    ).toHaveLength(0);
    await migratePostgresInsightsSource(db);
    await expect(source.capture()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    const installed = await state();
    await migratePostgresInsightsSource(db);
    expect(await state()).toEqual(installed);
    await source.backfillStep(2);
    const generation = JSON.parse(await source.capture());
    expect(generation).toEqual([1, installed.source_id, Array(16).fill("0")]);
  });

  it("assigns source once through direct append, preserves bigint strings, and hides private columns", async () => {
    await ready();
    const row = event(1);
    const shard = postgresEventSourceShard(row.id);
    const previous = "9007199254740992";
    await sql`update private_hot_updater_insights_source_clocks set committed_seq = ${previous}::bigint where shard = ${shard}`.execute(
      db,
    );
    await plugin.models.insights.append(row);
    const captured = await source.capture();
    expect(JSON.parse(captured)[2][shard]).toBe("9007199254740993");
    await expect(plugin.models.insights.append(row)).rejects.toMatchObject({
      code: "23505",
    });
    expect(await source.capture()).toBe(captured);
    expect(
      await source.readPage({
        sourceGeneration: captured,
        shard,
        afterSequence: previous,
        limit: 2,
      }),
    ).toEqual([{ sequence: "9007199254740993", event: row }]);
    expect(
      await plugin.models.insights.scan({ beforeReceivedAtMs: 2, limit: 2 }),
    ).toEqual([row]);
  });

  it("rolls back all event allocations and catalog changes after a late mixed-commit failure", async () => {
    await ready();
    const duplicate = event(1);
    await plugin.models.insights.append(duplicate);
    const before = await clocks();
    const bundle = createBundleRowFixture("77");
    const rows = [event(2), event(3)];
    await expect(
      plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          ...rows.map((row) => ({
            model: "insights" as const,
            operation: "insert" as const,
            row,
          })),
          { model: "insights", operation: "insert", row: duplicate },
        ],
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await clocks()).toEqual(before);
    expect(await plugin.models.bundles.findById(bundle.id)).toBeNull();
    expect(
      await plugin.models.insights.scan({ beforeReceivedAtMs: 100, limit: 10 }),
    ).toEqual([duplicate]);
    await expect(
      plugin.commit({
        changes: rows.map((row) => ({
          model: "insights",
          operation: "insert",
          row,
        })),
      }),
    ).resolves.toEqual({ committed: true });
    const prefix = await source.capture();
    await plugin.models.insights.append(event(4, 0));
    const captured = (
      await Promise.all(
        Array.from({ length: 16 }, (_, shard) =>
          source.readPage({ sourceGeneration: prefix, shard, limit: 10 }),
        ),
      )
    ).flat();
    expect(captured.map(({ event }) => event.id).sort()).toEqual(
      [duplicate, ...rows].map((row) => row.id).sort(),
    );
  });

  it("rejects missing source rows and a generation from a recreated layout", async () => {
    await ready();
    const row = event(1);
    await plugin.models.insights.append(row);
    const generation = await source.capture();
    await sql`delete from bundle_events where id = ${row.id}::uuid`.execute(db);
    await expect(
      source.readPage({
        sourceGeneration: generation,
        shard: postgresEventSourceShard(row.id),
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await client.exec(
      "update private_hot_updater_insights_source_state set source_id = gen_random_uuid()",
    );
    await expect(
      source.readPage({ sourceGeneration: generation, shard: 0, limit: 2 }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
  });

  it("rejects a dropped or incompatible source index before reading raw history", async () => {
    await ready();
    const row = event(1);
    await plugin.models.insights.append(row);
    const generation = await source.capture();
    await client.exec("drop index bundle_events_source_idx");
    const queries = vi.spyOn(client, "query");
    const read = () =>
      source.readPage({
        sourceGeneration: generation,
        shard: postgresEventSourceShard(row.id),
        limit: 2,
      });
    await expect(read()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await expect(source.capture()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await expect(migratePostgresInsightsSource(db)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(
      queries.mock.calls.some(([query]) =>
        /from bundle_events where/.test(query),
      ),
    ).toBe(false);
    await client.exec(
      "create unique index bundle_events_source_idx on bundle_events(insights_source_seq,insights_source_shard) where insights_source_shard is not null",
    );
    await expect(read()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await client.exec(
      "drop index bundle_events_source_idx; create unique index bundle_events_source_idx on bundle_events(insights_source_shard,insights_source_seq) where insights_source_shard is not null",
    );
    expect(await read()).toEqual([{ sequence: "1", event: row }]);
  });

  it("backfills bounded PK pages atomically, fences old writers and preserves extensions before the live writer cutover", async () => {
    const legacy = [10, 20, 30].map((id) => event(id));
    await db.insertInto("bundle_events").values(legacy).execute();
    await client.exec(
      "alter table bundle_events add column extension jsonb default '{\"keep\":[1,null,true]}'::jsonb",
    );
    await migratePostgresInsightsSource(db);
    await expect(
      db.insertInto("bundle_events").values(event(40)).execute(),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await source.backfillStep(2)).toEqual({
      ready: false,
      processed: 0,
    });
    const checkpoint = await state();
    const before = await clocks();
    await client.exec(`create function fail_source_update() returns trigger language plpgsql as $$
      begin if NEW.id = '${legacy[1]!.id}'::uuid then raise exception 'injected source write failure'; end if; return NEW; end; $$;
      create trigger fail_source_update before update of insights_source_seq on bundle_events for each row execute function fail_source_update();`);
    await expect(source.backfillStep(2)).rejects.toThrow(
      "injected source write failure",
    );
    expect(await clocks()).toEqual(before);
    expect(await state()).toEqual(checkpoint);
    expect(
      (await client.query("select insights_source_seq from bundle_events"))
        .rows,
    ).toEqual(Array(3).fill({ insights_source_seq: null }));
    await client.exec(
      "drop trigger fail_source_update on bundle_events; drop function fail_source_update()",
    );
    expect(await source.backfillStep(2)).toEqual({
      ready: false,
      processed: 2,
    });
    expect(await source.backfillStep(2)).toEqual({ ready: true, processed: 1 });
    expect((await state()).upper_id).toBe(legacy[2]!.id);
    const completed = await state();
    expect(await source.backfillStep(2)).toEqual({ ready: true, processed: 0 });
    expect(await state()).toEqual(completed);
    await migratePostgresInsightsLive(db);
    const live = createPostgresInsightsLiveTools(db);
    while (!(await live.backfillStep(2)).ready) {
      // Live backfill begins only after the earlier source cutover is complete.
    }
    await plugin.models.insights.append(event(5));
    await plugin.models.insights.append(event(40));
    expect(
      (await client.query("select extension from bundle_events")).rows,
    ).toEqual(Array(5).fill({ extension: { keep: [1, null, true] } }));
    const generation = await source.capture();
    const rows = (
      await Promise.all(
        Array.from({ length: 16 }, (_, shard) =>
          source.readPage({ sourceGeneration: generation, shard, limit: 20 }),
        ),
      )
    ).flat();
    expect(new Set(rows.map(({ event }) => event.id)).size).toBe(5);
  });

  it("limits actual PK and source index reads among more than 50,000 already indexed events", async () => {
    await migratePostgresInsightsSource(db);
    await client.exec(`with identities as (
      select ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid id,n from generate_series(0,50000)n
    ), sharded as (
      select *,get_byte(sha256(convert_to(id::text,'UTF8')),0)%16 shard from identities
    ), inserted as (
      insert into bundle_events (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms,insights_source_shard,insights_source_seq)
      select id,'UNCHANGED','installation',null,'00000000-0000-0000-0000-000000000001','ios','1.0','production','default',null,n,shard,row_number() over(partition by shard order by id) from sharded returning insights_source_shard
    ) update private_hot_updater_insights_source_clocks c set committed_seq=(select count(*) from inserted where insights_source_shard=c.shard);
    analyze bundle_events;`);
    const queries = vi.spyOn(client, "query");
    await source.backfillStep(2);
    expect(await source.backfillStep(2)).toEqual({
      ready: false,
      processed: 2,
    });
    const pkCall = queries.mock.calls.find(([query]) =>
      /order by id asc limit/.test(query),
    )!;
    expect(pkCall).toBeDefined();
    const plan = await client.query<{
      "QUERY PLAN": { Plan: ExplainPlan }[];
    }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${pkCall[0]}`, pkCall[1]);
    assertBoundedIndexPlan(
      plan.rows[0]!["QUERY PLAN"][0]!.Plan,
      "bundle_events_pkey",
      2,
    );
    queries.mockRestore();
    // Every step skips only its own <=200 already assigned rows, without refill.
    let steps = 0;
    while (!(await source.backfillStep(200)).ready)
      expect(++steps).toBeLessThan(251);
    expect(steps).toBe(249);
    const generation = await source.capture();
    const reads = vi.spyOn(client, "query");
    expect(
      await source.readPage({
        sourceGeneration: generation,
        shard: 0,
        afterSequence: "100",
        limit: 2,
      }),
    ).toHaveLength(2);
    const sourceCall = reads.mock.calls.find(([query]) =>
      /order by insights_source_seq asc limit/.test(query),
    )!;
    const sourcePlan = await client.query<{
      "QUERY PLAN": { Plan: ExplainPlan }[];
    }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sourceCall[0]}`, sourceCall[1]);
    assertBoundedIndexPlan(
      sourcePlan.rows[0]!["QUERY PLAN"][0]!.Plan,
      "bundle_events_source_idx",
      2,
    );
  }, 60_000);
});
