import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  sql,
  type DatabaseConnection,
} from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import {
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import {
  readPostgresInsightsReportOrderRange,
  stepPostgresInsightsReportOrder,
} from "./postgresInsightsReportOrder";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import { createPostgresInsightsSearchPages } from "./postgresInsightsSearchPages";
import {
  appendPostgresInsightsEvent,
  createPostgresInsightsSourceTools,
} from "./postgresInsightsSource";
import type { Database } from "./types";

const jobsTable = "private_hot_updater_insights_report_jobs";
const heads = "private_hot_updater_insights_report_heads";
const counts = "private_hot_updater_insights_report_counts";
const latest = "private_hot_updater_insights_report_latest";
const orderRows = "private_hot_updater_insights_report_order_rows";
const orderStates = "private_hot_updater_insights_report_order_states";
const asOfMs = Date.UTC(2026, 0, 11, 12);
const section = { section: "installationIds" } as const;
type Query = { sql: string; parameters: readonly unknown[] };
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

describe("PostgreSQL frozen contains search and native read bounds", () => {
  const container = `hot-updater-search-${randomUUID().slice(0, 8)}`;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pageDb: Kysely<Database>;
  let pageConnection: DatabaseConnection;
  let afterMetadata: (() => Promise<void>) | undefined;
  let queries: Query[] = [];
  let pageQueries: Query[] = [];
  const jobs = () => createPostgresInsightsJobs(db);
  const pages = () => createPostgresInsightsSearchPages(pageDb);

  beforeAll(async () => {
    docker(["image", "inspect", "postgres:15-alpine"]);
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
      "postgres:15-alpine",
    ]);
    const deadline = Date.now() + 20_000;
    while (
      spawnSync("docker", [
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ]).status !== 0
    ) {
      if (Date.now() > deadline)
        throw new Error("PostgreSQL search fixture did not start.");
      await setTimeout(100);
    }
    const config = {
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
    };
    pool = new pg.Pool(config);
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query")
          queries.push({
            sql: event.query.sql,
            parameters: event.query.parameters,
          });
      },
    });
    pageDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...config, max: 1 }),
        onCreateConnection: async (connection) => {
          pageConnection = connection;
        },
      }),
      log: (event) => {
        if (event.level === "query")
          pageQueries.push({
            sql: event.query.sql,
            parameters: event.query.parameters,
          });
      },
      plugins: [
        {
          transformQuery: ({ node }) => node,
          async transformResult({ result }) {
            const row = result.rows[0];
            if (
              afterMetadata &&
              typeof row === "object" &&
              row !== null &&
              "canonical_query" in row &&
              "publication" in row
            ) {
              const hook = afterMetadata;
              afterMetadata = undefined;
              await hook();
            }
            return result;
          },
        },
      ],
    });
  });
  beforeEach(async () => {
    afterMetadata = undefined;
    await pool.query("drop schema public cascade; create schema public");
    await pool.query(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    await migratePostgresInsightsSource(db);
    await migratePostgresInsightsReports(db);
    await createPostgresInsightsSourceTools(db).backfillStep(1);
    await pool.query("create table readonly_probe(id integer primary key)");
    queries = [];
    pageQueries = [];
  });
  afterAll(async () => {
    await pageDb?.destroy();
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  const append = (
    id: number,
    time: number,
    installId: string,
    userId: string,
  ) =>
    appendPostgresInsightsEvent(db, {
      ...createBundleEventRowFixture(String(id), time),
      install_id: installId,
      user_id: userId,
    });
  const seedHistory = async () => {
    await append(1, asOfMs - 30, "alpha", "old-owner");
    await append(2, asOfMs - 20, "alpha", "current-owner");
    await append(3, asOfMs - 10, "beta", "old-owner");
  };
  const finish = async (jobId: string) => {
    const worker = createPostgresInsightsReportWorker(db);
    for (let i = 0; i < 200; i++) {
      const result = await worker.runStep({ maxItems: 256, maxRequests: 128 });
      if (result.state === "published" && result.jobId === jobId) return;
      expect(result.state).toBe("progress");
    }
    throw new Error("Small search fixture exceeded its bounded step count.");
  };
  const prepareSearch = async (cutoff = asOfMs) => {
    const base = await jobs().getReport({
      query: { kind: "installationOverview" },
      minAsOfMs: cutoff,
    });
    if (base.state !== "queued")
      throw new Error("Expected a new fixture base.");
    await sql`update ${sql.table(jobsTable)} set as_of_ms=${cutoff} where id=${base.jobId}::uuid`.execute(
      db,
    );
    await finish(base.jobId);
    const search = await jobs().getSearch({ query: "old", minAsOfMs: cutoff });
    if (search.state !== "queued")
      throw new Error("Expected a new fixture search.");
    queries = [];
    await finish(search.jobId);
    expect(
      queries.some(({ sql }) =>
        /bundle_events|private_hot_updater_insights_source_/i.test(sql),
      ),
    ).toBe(false);
    const ready = await jobs().getSearch({ query: "OLD", minAsOfMs: cutoff });
    if (ready.state !== "ready")
      throw new Error("Expected the completed search.");
    return { baseId: base.jobId, publication: ready.publication };
  };

  it("serves historical matches and frozen latest metadata inside a real read-only repeatable-read transaction", async () => {
    await seedHistory();
    const { publication } = await prepareSearch();
    const input = {
      kind: "contains",
      query: "OLD",
      publicationId: publication.id,
      limit: 1,
    } as const;
    let settings: unknown;
    afterMetadata = async () => {
      settings = (
        await pageConnection.executeQuery(
          CompiledQuery.raw(
            "select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only",
          ),
        )
      ).rows;
    };
    pageQueries = [];
    const first = await pages().pageContains(input);
    expect(first).toMatchObject({
      state: "ready",
      consistency: "snapshot",
      publication: { total: 2, asOfMs },
      rows: [{ install_id: "alpha", user_id: "current-owner" }],
    });
    expect(settings).toEqual([
      { isolation: "repeatable read", read_only: "on" },
    ]);
    expect(pageQueries[0]!.sql).toMatch(
      /start transaction isolation level repeatable read read only/i,
    );
    expect(
      pageQueries.some(({ sql }) =>
        /bundle_events|^\s*(insert|update|delete)/i.test(sql),
      ),
    ).toBe(false);
    if (
      first.state !== "ready" ||
      first.consistency !== "snapshot" ||
      first.nextCursor === null
    )
      throw new Error("Expected the second frozen page.");
    expect(
      await pages().pageContains({ ...input, cursor: first.nextCursor }),
    ).toMatchObject({
      rows: [{ install_id: "beta", user_id: "old-owner" }],
      nextCursor: null,
    });
    afterMetadata = async () => {
      await pageConnection.executeQuery(
        CompiledQuery.raw("insert into readonly_probe values(1)"),
      );
    };
    await expect(pages().pageContains(input)).rejects.toMatchObject({
      code: "25006",
    });
    expect((await pool.query("select * from readonly_probe")).rows).toEqual([]);
  });

  it("preserves old pages through a concurrent refresh and rolls back cleanup of a still-pinned base", async () => {
    await seedHistory();
    const old = await prepareSearch();
    const input = {
      kind: "contains",
      query: "old",
      publicationId: old.publication.id,
      limit: 1,
    } as const;
    const before = await pages().pageContains(input);
    let refreshed: Awaited<ReturnType<typeof prepareSearch>> | undefined;
    afterMetadata = async () => {
      await append(4, asOfMs + 1, "alpha", "new-current-owner");
      await append(5, asOfMs + 1, "gamma", "old-owner");
      refreshed = await prepareSearch(asOfMs + 2);
      expect(
        (
          await pool.query(
            `select query_key from ${heads} where active_job_id=$1::uuid or publication_job_id=$1::uuid`,
            [old.baseId],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        db.transaction().execute(async (tx) => {
          // Explicit cleanup must be atomic: a live search pin rejects the final
          // base deletion and rolls these derived-row removals back with it.
          for (const table of [
            "private_hot_updater_insights_report_aliases",
            latest,
            counts,
            orderRows,
            orderStates,
          ])
            await sql`delete from ${sql.table(table)} where job_id=${old.baseId}::uuid`.execute(
              tx,
            );
          await sql`delete from ${sql.table(jobsTable)} where id=${old.baseId}::uuid`.execute(
            tx,
          );
        }),
      ).rejects.toMatchObject({ code: "23503" });
    };
    expect(await pages().pageContains(input)).toEqual(before);
    expect(refreshed).toBeDefined();
    expect(
      await pages().pageContains({
        ...input,
        publicationId: refreshed!.publication.id,
        limit: 3,
      }),
    ).toMatchObject({
      publication: { total: 3, asOfMs: asOfMs + 2 },
      rows: [
        { install_id: "alpha", user_id: "new-current-owner" },
        { install_id: "beta", user_id: "old-owner" },
        { install_id: "gamma", user_id: "old-owner" },
      ],
    });
    expect(await pages().pageContains(input)).toEqual(before);
    if (before.state !== "ready" || before.nextCursor === null)
      throw new Error("Expected old continuation.");
    expect(
      await pages().pageContains({ ...input, cursor: before.nextCursor }),
    ).toMatchObject({
      rows: [{ install_id: "beta" }],
      publication: old.publication,
    });
    expect(
      (
        await pool.query(
          `select base_job_id from ${jobsTable} where id=$1::uuid`,
          [old.publication.id],
        )
      ).rows,
    ).toEqual([{ base_job_id: old.baseId }]);
  });

  it.each([
    [
      "count PK",
      `alter table ${counts} drop constraint ${counts}_pkey`,
      "worker",
      counts,
    ],
    [
      "count ordering index",
      "drop index insights_report_counts_order_input_idx",
      "page",
      orderRows,
    ],
    [
      "order PK",
      `alter table ${orderRows} drop constraint ${orderRows}_pkey`,
      "page",
      orderRows,
    ],
    [
      "latest PK",
      `alter table ${latest} drop constraint ${latest}_pkey`,
      "page",
      latest,
    ],
  ])(
    "rejects a missing %s before the corresponding derived data read",
    async (_, drop, target, table) => {
      await seedHistory();
      const { publication } = await prepareSearch();
      await pool.query(drop);
      queries = [];
      pageQueries = [];
      await expect(
        target === "worker"
          ? createPostgresInsightsReportWorker(db).runStep({
              maxItems: 256,
              maxRequests: 128,
            })
          : pages().pageContains({
              kind: "contains",
              query: "old",
              publicationId: publication.id,
              limit: 100,
            }),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      const calls = target === "worker" ? queries : pageQueries;
      expect(
        calls.some(({ sql }) =>
          new RegExp(`(?:from|into|update)\\s+"?${table}\\b`, "i").test(sql),
        ),
      ).toBe(false);
      expect(calls.some(({ sql }) => /bundle_events/.test(sql))).toBe(false);
    },
  );

  it("uses bounded installationIds copy and final-ordinal seeks with 50,001 matching derived rows under custom and generic plans", async () => {
    const fixtureId = randomUUID();
    // Planner-only private fixture: this deliberately bypasses worker creation.
    // Neither SQL bulk population nor ready-state construction is a page read.
    await pool.query(
      `insert into ${counts}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      select $1::uuid,encode(sha256(convert_to(identity,'UTF8')),'hex'),identity::jsonb,
        'installationIds','',label,-1,1
      from (select 'install-'||lpad(n::text,5,'0') label,
        '["installationIds","","install-'||lpad(n::text,5,'0')||'",-1]' identity from generate_series(0,50000)n)fixture`,
      [fixtureId],
    );
    await pool.query(
      `insert into ${counts}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      select $1::uuid,encode(sha256(convert_to(identity,'UTF8')),'hex'),identity::jsonb,
        'movementSeries','installed','',n,1
      from (select n,'["movementSeries","installed","",'||n::text||']' identity from generate_series(0,50000)n)fixture`,
      [fixtureId],
    );
    await pool.query(`analyze ${counts}`);
    queries = [];
    expect(
      await db
        .transaction()
        .execute((tx) =>
          stepPostgresInsightsReportOrder(tx, fixtureId, section),
        ),
    ).toEqual({ ready: false, processed: 32 });
    const copy = queries.find(({ sql }) =>
      /order by count_key limit/.test(sql),
    )!;
    expect(copy).toBeDefined();
    type Plan = {
      "Node Type": string;
      "Actual Rows": number;
      "Actual Loops": number;
      "Index Name"?: string;
      "Index Cond"?: string;
      "Rows Removed by Filter"?: number;
      Plans?: Plan[];
    };
    let probe = 0;
    const explain = async (
      query: Query,
      index: string,
      bound: number,
      connection: pg.Pool | pg.PoolClient = pool,
    ) => {
      const result = await connection.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
        `explain (analyze,buffers,format json) ${query.sql}`,
        [...query.parameters],
      );
      const plan = result.rows[0]!["QUERY PLAN"][0]!.Plan;
      process.stdout.write(`${JSON.stringify({ query: query.sql, plan })}\n`);
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      expect(
        nodes.some((node) => node["Index Name"] === index),
        JSON.stringify(plan),
      ).toBe(true);
      for (const node of nodes) {
        expect(node["Node Type"], JSON.stringify(node)).not.toMatch(
          /Seq Scan|Sort/,
        );
        expect(
          node["Actual Rows"] * node["Actual Loops"],
          JSON.stringify(node),
        ).toBeLessThanOrEqual(bound);
        expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
      }
      return nodes;
    };
    const explainBoth = async (query: Query, index: string, bound: number) => {
      await explain(query, index, bound);
      const connection = await pool.connect();
      const name = `search_plan_${++probe}`;
      try {
        await connection.query("begin");
        await connection.query("set local plan_cache_mode=force_generic_plan");
        await connection.query(`prepare ${name} as ${query.sql}`);
        const nodes = await explain(
          {
            sql: `execute ${name}(${query.parameters.map((value) => pg.escapeLiteral(String(value))).join(",")})`,
            parameters: [],
          },
          index,
          bound,
          connection,
        );
        expect(nodes.some((node) => node["Index Cond"]?.includes("$1"))).toBe(
          true,
        );
      } finally {
        await connection.query("rollback");
        connection.release();
      }
    };
    await explainBoth(copy, "insights_report_counts_order_input_idx", 32);
    await pool.query(
      `insert into ${orderRows}(job_id,section,metric,sort_pass,run_number,row_position,label,value,count_key)
      select job_id,section,metric,11,0,substring(label from 9)::bigint,label,value,count_key
      from ${counts} where job_id=$1::uuid and section='installationIds'`,
      [fixtureId],
    );
    await pool.query(
      `update ${orderStates} set phase='ready',total_rows=50001,sort_pass=11,
      after_count_key=(select max(count_key) from ${counts} where job_id=$1::uuid and section='installationIds')
      where job_id=$1::uuid and section='installationIds'`,
      [fixtureId],
    );
    await pool.query(`analyze ${orderRows}`);
    queries = [];
    const range = await readPostgresInsightsReportOrderRange(
      db,
      fixtureId,
      section,
      "11",
      "40000",
      101,
    );
    expect(range.map((row) => row.label)).toEqual(
      Array.from({ length: 101 }, (_, i) => `install-${40000 + i}`),
    );
    expect(
      queries.some(({ sql }) =>
        /bundle_events|^\s*(insert|update|delete)/i.test(sql),
      ),
    ).toBe(false);
    const read = queries.find(({ sql }) =>
      /order by row_position limit/.test(sql),
    )!;
    await explainBoth(read, `${orderRows}_pkey`, 101);
  });
});
