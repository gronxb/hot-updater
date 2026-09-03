import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import {
  migratePostgresInsightsLive,
  migratePostgresInsightsSource,
} from "./db";
import { postgres } from "./postgres";
import { POSTGRES_INSIGHTS_EVENT_COLUMNS } from "./postgresInsightsContract";
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

const insightsDatabaseNamespace = "00000000-0000-4000-8000-000000000001";

type Plan = {
  "Node Type": string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: Plan[];
};

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};

const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(50);
  }
  throw new Error("PostgreSQL live fixture did not become ready");
};

const nodes = (root: Plan): Plan[] => {
  const result: Plan[] = [];
  const visit = (node: Plan) => {
    result.push(node);
    node.Plans?.forEach(visit);
  };
  visit(root);
  return result;
};

const assertNativePage = (root: Plan) => {
  const all = nodes(root);
  expect(
    all.some(
      (node) =>
        node["Index Name"] ===
        "private_hot_updater_insights_live_installations_pkey",
    ),
  ).toBe(true);
  for (const node of all) {
    expect(node["Node Type"]).not.toMatch(/Seq Scan|Sort|Bitmap/);
    expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(101);
    expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
    expect(node["Rows Removed by Index Recheck"] ?? 0).toBe(0);
  }
};

const assertNativeBackfill = (root: Plan) => {
  const all = nodes(root);
  expect(all.some((node) => node["Index Name"] === "bundle_events_pkey")).toBe(
    true,
  );
  for (const node of all) {
    expect(node["Node Type"]).not.toMatch(/Seq Scan|Sort|Bitmap/);
    expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(200);
    expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
    expect(node["Rows Removed by Index Recheck"] ?? 0).toBe(0);
  }
};

describe("PostgreSQL native live installation pages", () => {
  const containers: string[] = [];
  const versions = [
    "15",
    ...(process.env.POSTGRES_INSIGHTS_TEST_VERSION_17 === "1"
      ? (["17"] as const)
      : []),
  ] as const;

  afterEach(() => {
    for (const container of containers.splice(0))
      spawnSync("docker", ["rm", "--force", container]);
  });

  it.each(versions)(
    "keeps backfill and pages bounded on PostgreSQL %s",
    async (version) => {
      const image = `postgres:${version}-alpine`;
      docker(["image", "inspect", image]);
      const container = `hot-updater-live-${version}-${randomUUID().slice(0, 8)}`;
      containers.push(container);
      const port = await findOpenPort();
      docker([
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        container,
        "--tmpfs",
        "/var/lib/postgresql/data:rw,size=512m",
        "-p",
        `127.0.0.1:${port}:5432`,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        image,
      ]);
      await waitUntil(
        () =>
          spawnSync("docker", [
            "exec",
            container,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "postgres",
          ]).status === 0,
      );
      const pool = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        database: "postgres",
        max: 5,
      });
      const captured: { sql: string; parameters: readonly unknown[] }[] = [];
      const db = new Kysely<Database>({
        dialect: new PostgresDialect({ pool }),
        log(event) {
          if (event.level === "query")
            captured.push({
              sql: event.query.sql,
              parameters: event.query.parameters,
            });
        },
      });
      const plugin = postgres({
        host: "127.0.0.1",
        port,
        user: "postgres",
        database: "postgres",
        max: 2,
      });
      try {
        await pool.query(
          await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
        );
        const event = (
          suffix: string,
          installId: string,
          receivedAtMs: number,
        ): BundleEventRow => ({
          ...createBundleEventRowFixture(suffix, receivedAtMs),
          install_id: installId,
        });
        const oldHot = event("100", "hot", 10);
        const newHot = event("200", "hot", 20);
        const legacy = event("300", "legacy", 30);
        await db
          .insertInto("bundle_events")
          .values([oldHot, newHot, legacy])
          .execute();
        await migratePostgresInsightsSource(db, insightsDatabaseNamespace);
        const source = createPostgresInsightsSourceTools(
          db,
          insightsDatabaseNamespace,
        );
        while (!(await source.backfillStep(2)).ready) {
          // Three legacy rows require only bounded source pages.
        }
        await migratePostgresInsightsLive(db, insightsDatabaseNamespace);
        const live = createPostgresInsightsLiveTools(
          db,
          insightsDatabaseNamespace,
        );
        expect(await live.backfillStep(1)).toEqual({
          ready: false,
          processed: 0,
        });
        expect(await live.backfillStep(1)).toEqual({
          ready: false,
          processed: 1,
        });
        // This UUID sorts before the durable backfill checkpoint. Its direct
        // writer must still publish the projection atomically.
        const concurrent = event("50", "concurrent", 40);
        const [concurrentStep] = await Promise.all([
          live.backfillStep(1),
          plugin.models.insights.append(concurrent),
        ]);
        expect(concurrentStep).toEqual({ ready: false, processed: 1 });
        while (!(await live.backfillStep(1)).ready) {
          // Remaining legacy rows are each read once through bounded PK pages.
        }
        const semantic = await createPostgresInsightsLivePages(db).pageAll({
          kind: "all",
          limit: 10,
        });
        expect(semantic).toMatchObject({
          state: "ready",
          consistency: "live",
          rows: expect.arrayContaining([
            expect.objectContaining({ id: newHot.id, install_id: "hot" }),
            expect.objectContaining({
              id: legacy.id,
              install_id: "legacy",
            }),
            expect.objectContaining({
              id: concurrent.id,
              install_id: "concurrent",
            }),
          ]),
        });
        if (semantic.state !== "ready") throw new Error("expected live page");
        expect(semantic.rows).toHaveLength(3);

        const unfenced = event("400", "old-writer", 40);
        await expect(
          sql`insert into bundle_events
            (${sql.join(POSTGRES_INSIGHTS_EVENT_COLUMNS.map((field) => sql.ref(field)))},
              insights_source_shard,insights_source_seq)
            values (${sql.join(POSTGRES_INSIGHTS_EVENT_COLUMNS.map((field) => unfenced[field]))},
              ${postgresEventSourceShard(unfenced.id)},9999)`.execute(db),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "bundle_events_live_required",
        });

        const victim = event("500", "digest-victim", 50);
        const corrupt = event("501", "other-identity", 49);
        await sql`insert into ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
          (install_key,install_id,event_id,received_at_ms,event) values
          (${postgresInsightsInstallKey(victim.install_id)},${corrupt.install_id},
            ${corrupt.id}::uuid,${corrupt.received_at_ms},
            ${JSON.stringify(corrupt)}::jsonb)`.execute(db);
        await expect(
          plugin.models.insights.append(victim),
        ).rejects.toMatchObject({ code: "23502" });
        expect(
          await sql<{
            count: string;
          }>`select count(*)::text count from bundle_events
            where id=${victim.id}::uuid`.execute(db),
        ).toMatchObject({ rows: [{ count: "0" }] });
        await sql`delete from ${sql.table(POSTGRES_INSIGHTS_LIVE_TABLE)}
          where install_key=${postgresInsightsInstallKey(victim.install_id)}`.execute(
          db,
        );

        // Bulk fixture creation is outside the bounded backfill operation. It
        // represents pre-cutover raw rows with an already committed source.
        const template = JSON.stringify(event("600", "bulk", 1));
        await pool.query(`with ids as (
          select n,('10000000-0000-7000-8000-' || lpad(n::text,12,'0'))::uuid id
          from generate_series(1,50001)n
        ), sharded as (
          select *,get_byte(sha256(convert_to(id::text,'UTF8')),0)%16 shard from ids
        ), numbered as (
          select s.*,c.committed_seq + row_number() over(partition by shard order by id) sequence
          from sharded s join private_hot_updater_insights_source_clocks c using(shard)
        ), events as (
          select numbered.*, '${template}'::jsonb || jsonb_build_object(
            'id',id,'install_id','bulk-' || n,'received_at_ms',n) event
          from numbered
        ) insert into bundle_events select (jsonb_populate_record(null::bundle_events,
          event || jsonb_build_object(
            'insights_source_shard',shard,'insights_source_seq',sequence,
            'insights_event',event,'insights_live_version',1))).* from events;
        update private_hot_updater_insights_source_clocks c set committed_seq=s.last_sequence
          from (select insights_source_shard,max(insights_source_seq) last_sequence
            from bundle_events group by insights_source_shard)s
          where c.shard=s.insights_source_shard;
        truncate ${POSTGRES_INSIGHTS_LIVE_TABLE};
        update private_hot_updater_insights_live_state set initialized=false,ready=false,
          upper_id=null,after_id=null,revision=revision+1 where id=1;
        analyze bundle_events;`);
        expect(await live.backfillStep(200)).toEqual({
          ready: false,
          processed: 0,
        });
        captured.length = 0;
        expect(await live.backfillStep(200)).toEqual({
          ready: false,
          processed: 200,
        });
        const backfillQuery = captured.find(({ sql }) =>
          /from bundle_events where id <=/.test(sql),
        );
        expect(backfillQuery).toBeDefined();
        const backfillPlan = await pool.query<{
          "QUERY PLAN": { Plan: Plan }[];
        }>(`explain (analyze,buffers,format json) ${backfillQuery!.sql}`, [
          ...backfillQuery!.parameters,
        ]);
        const rawPlan = backfillPlan.rows[0]!["QUERY PLAN"][0]!.Plan;
        assertNativeBackfill(rawPlan);
        for (let step = 0; step < 251; step++) {
          if ((await live.backfillStep(200)).ready) break;
          expect(step).toBeLessThan(250);
        }
        await pool.query(`analyze ${POSTGRES_INSIGHTS_LIVE_TABLE}`);
        const pages = createPostgresInsightsLivePages(db);
        const first = await pages.pageAll({ kind: "all", limit: 100 });
        if (first.state !== "ready" || first.nextCursor === null)
          throw new Error("expected first native page");
        captured.length = 0;
        const second = await pages.pageAll({
          kind: "all",
          limit: 100,
          cursor: first.nextCursor,
        });
        expect(second.state).toBe("ready");
        const dataQuery = captured.find(({ sql }) =>
          /select\s+encode\(live\.install_key/.test(sql),
        );
        expect(dataQuery).toBeDefined();
        const custom = await pool.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
          `explain (analyze,buffers,format json) ${dataQuery!.sql}`,
          [...dataQuery!.parameters],
        );
        const customPlan = custom.rows[0]!["QUERY PLAN"][0]!.Plan;
        await pool.query("set plan_cache_mode=force_generic_plan");
        await pool.query(
          `prepare live_page(text,integer) as ${dataQuery!.sql}`,
        );
        const cursorHex = dataQuery!.parameters[0];
        if (typeof cursorHex !== "string" || !/^[0-9a-f]{64}$/.test(cursorHex))
          throw new Error("unexpected page cursor parameter");
        const generic = await pool.query<{
          "QUERY PLAN": { Plan: Plan }[];
        }>(
          `explain (analyze,buffers,format json) execute live_page('${cursorHex}',101)`,
        );
        const genericPlan = generic.rows[0]!["QUERY PLAN"][0]!.Plan;
        process.stdout.write(
          `${JSON.stringify({
            kind: "postgres-insights-live-page-plan",
            version,
            fixtureRows: 50_004,
            backfill: rawPlan,
            custom: customPlan,
            generic: genericPlan,
          })}\n`,
        );
        assertNativePage(customPlan);
        assertNativePage(genericPlan);

        await pool.query(`alter table ${POSTGRES_INSIGHTS_LIVE_TABLE}
          drop constraint private_hot_updater_insights_live_installations_pkey`);
        captured.length = 0;
        await expect(
          pages.pageAll({ kind: "all", limit: 1 }),
        ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
        expect(
          captured.some(({ sql }) =>
            /select\s+encode\(live\.install_key/.test(sql),
          ),
        ).toBe(false);
      } finally {
        await plugin.dispose?.();
        await db.destroy();
      }
    },
    120_000,
  );
});
