import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import type { InsightsReportQuery } from "@hot-updater/plugin-core";
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
  migratePostgresInsightsLive,
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import {
  assertPostgresInsightsReportDataIndexes,
  readPostgresInsightsFirstMovementBucket,
} from "./postgresInsightsReportData";
import { createPostgresInsightsReportPages } from "./postgresInsightsReportPages";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import {
  appendPostgresInsightsEvent,
  createPostgresInsightsSourceTools,
} from "./postgresInsightsSource";
import type { Database } from "./types";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000f001";

const jobsTable = "private_hot_updater_insights_report_jobs";
const headsTable = "private_hot_updater_insights_report_heads";
const countsTable = "private_hot_updater_insights_report_counts";
const day = 86_400_000;
const asOfMs = Date.UTC(2026, 0, 11, 12);
const bundleA = createBundleEventRowFixture("1", 1).to_bundle_id;
const bundleB = createBundleEventRowFixture("2", 1).to_bundle_id;
const postgresImage =
  process.env.POSTGRES_INSIGHTS_TEST_VERSION_17 === "1"
    ? "postgres:17-alpine"
    : "postgres:15-alpine";
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

describe("PostgreSQL report page snapshot and physical read bounds", () => {
  const container = `hot-updater-pages-${randomUUID().slice(0, 8)}`;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pageDb: Kysely<Database>;
  let pageConnection: DatabaseConnection;
  let afterMetadata: (() => Promise<void>) | undefined;
  let pageQueries: string[] = [];
  let queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const jobs = () => createPostgresInsightsJobs(db, insightsDatabaseNamespace);
  const pages = () =>
    createPostgresInsightsReportPages(pageDb, insightsDatabaseNamespace);

  beforeAll(async () => {
    docker(["image", "inspect", postgresImage]);
    const port = await findOpenPort();
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      container,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=256m",
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      postgresImage,
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
        throw new Error("PostgreSQL page fixture did not start.");
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
        // One page connection lets the probe inspect the actual transaction,
        // rather than a different pool connection with default settings.
        pool: new pg.Pool({ ...config, max: 1 }),
        onCreateConnection: async (connection) => {
          pageConnection = connection;
        },
      }),
      log: (event) => {
        pageQueries.push(event.query.sql);
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
              // The publication was read, but its derived rows have not been.
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
    await migratePostgresInsightsSource(db, insightsDatabaseNamespace);
    await migratePostgresInsightsReports(db, insightsDatabaseNamespace);
    await createPostgresInsightsSourceTools(
      db,
      insightsDatabaseNamespace,
    ).backfillStep(1);
    await migratePostgresInsightsLive(db, insightsDatabaseNamespace);
    await createPostgresInsightsLiveTools(
      db,
      insightsDatabaseNamespace,
    ).backfillStep(1);
    await pool.query("create table page_write_probe(id integer primary key)");
    pageQueries = [];
    queries = [];
  });
  afterAll(async () => {
    await pageDb?.destroy();
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  const append = async (id: number, time: number, bundleId = bundleA) =>
    appendPostgresInsightsEvent(
      db,
      {
        ...createBundleEventRowFixture(String(id), time),
        to_bundle_id: bundleId,
      },
      insightsDatabaseNamespace,
    );
  const reserve = async (query: InsightsReportQuery, cutoff = asOfMs) => {
    const result = await jobs().getReport({ query, minAsOfMs: cutoff });
    if (result.state !== "queued")
      throw new Error("Expected a queued fixture report.");
    await sql`update ${sql.table(jobsTable)} set as_of_ms=${cutoff} where id=${result.jobId}::uuid`.execute(
      db,
    );
    return result.jobId;
  };
  const finish = async (query: InsightsReportQuery, cutoff = asOfMs) => {
    const worker = createPostgresInsightsReportWorker(
      db,
      insightsDatabaseNamespace,
    );
    for (let step = 0; step < 100; step++) {
      const result = await worker.runStep({ maxItems: 256, maxRequests: 128 });
      if (result.state === "published") {
        const report = await jobs().getReport({ query, minAsOfMs: cutoff });
        if (report.state !== "ready")
          throw new Error("Expected a published fixture report.");
        return report.publication;
      }
      expect(result.state).toBe("progress");
    }
    throw new Error("Small report fixture exceeded its bounded step count.");
  };

  it("uses an actual repeatable-read, read-only PostgreSQL transaction for pages", async () => {
    await append(1, asOfMs - 1);
    const query = { kind: "installationOverview" } as const;
    const publicationId = await reserve(query);
    await finish(query);
    let settings: unknown;
    afterMetadata = async () => {
      settings = (
        await pageConnection.executeQuery(
          CompiledQuery.raw(
            "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
          ),
        )
      ).rows;
    };
    const input = {
      publicationId,
      section: "bundleDistribution",
      limit: 1,
    } as const;
    expect(await pages().pageReport(input)).toMatchObject({
      state: "ready",
      rows: [{ bundleId: bundleA, installations: 1 }],
    });
    expect(settings).toEqual([
      { isolation: "repeatable read", read_only: "on" },
    ]);
    expect(pageQueries[0]).toMatch(
      /start transaction isolation level repeatable read read only/i,
    );
    afterMetadata = async () => {
      await pageConnection.executeQuery(
        CompiledQuery.raw("insert into page_write_probe values (1)"),
      );
    };
    await expect(pages().pageReport(input)).rejects.toMatchObject({
      code: "25006",
    });
    expect((await pool.query("select * from page_write_probe")).rows).toEqual(
      [],
    );
  });

  it("keeps metadata and rows in one snapshot while another connection refreshes and cleans up", async () => {
    await append(1, asOfMs - 1);
    const query = { kind: "installationOverview" } as const;
    const oldId = await reserve(query);
    await finish(query);
    const input = {
      publicationId: oldId,
      section: "bundleDistribution",
      limit: 1,
    } as const;
    const before = await pages().pageReport(input);
    let nextId: string | undefined;
    afterMetadata = async () => {
      await append(2, asOfMs + 1, bundleB);
      nextId = await reserve(query, asOfMs + 2);
      await finish(query, asOfMs + 2);
      await db.transaction().execute(async (transaction) => {
        for (const table of [
          "private_hot_updater_insights_report_order_rows",
          "private_hot_updater_insights_report_order_states",
          countsTable,
        ])
          await sql`delete from ${sql.table(table)} where job_id=${oldId}::uuid`.execute(
            transaction,
          );
        await sql`delete from ${sql.table(jobsTable)} where id=${oldId}::uuid`.execute(
          transaction,
        );
      });
      expect(
        (await pool.query(`select id from ${jobsTable} where id=$1`, [oldId]))
          .rows,
      ).toEqual([]);
    };
    expect(await pages().pageReport(input)).toEqual(before);
    expect(nextId).toBeDefined();
    expect(
      await pages().pageReport({ ...input, publicationId: nextId!, limit: 2 }),
    ).toMatchObject({
      state: "ready",
      rows: [
        { bundleId: bundleA, installations: 1 },
        { bundleId: bundleB, installations: 1 },
      ].sort((left, right) => (left.bundleId < right.bundleId ? -1 : 1)),
    });
    expect(await pages().pageReport(input)).toEqual({
      state: "expired",
      publicationId: oldId,
    });
  });

  it("seeks the first metric bucket through its native index amid 50,001 unrelated counters", async () => {
    const jobId = await reserve({
      kind: "bundleDetail",
      bundleId: bundleA,
      window: "all",
    });
    await pool.query(
      `insert into ${countsTable}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      select $1::uuid,encode(sha256(convert_to(identity_text,'UTF8')),'hex'),identity_text::jsonb,
        'movementCohorts','installed','cohort-'||n,-1,1
      from (select n,'["movementCohorts","installed","cohort-'||n||'",-1]' as identity_text from generate_series(0,50000)n) fixture`,
      [jobId],
    );
    for (const [metric, bucket] of [
      ["installed", day],
      ["installed", 3 * day],
      ["recovered", 0],
      ["recovered", 2 * day],
    ] as const) {
      const identity = JSON.stringify(["movementSeries", metric, "", bucket]);
      await pool.query(
        `insert into ${countsTable}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
        values($1,$2,$3::jsonb,'movementSeries',$4,'',$5,1)`,
        [
          jobId,
          createHash("sha256").update(identity).digest("hex"),
          identity,
          metric,
          bucket,
        ],
      );
    }
    await pool.query(`analyze ${countsTable}`);
    await assertPostgresInsightsReportDataIndexes(db);
    expect(
      (
        await pool.query<{ predicate: string }>(
          "select pg_get_expr(indpred,indrelid) as predicate from pg_index where indexrelid='insights_report_counts_bucket_idx'::regclass",
        )
      ).rows,
    ).toEqual([{ predicate: "(section = 'movementSeries'::text)" }]);
    queries = [];
    expect(
      await readPostgresInsightsFirstMovementBucket(db, jobId, "installed"),
    ).toBe(day);
    expect(
      await readPostgresInsightsFirstMovementBucket(db, jobId, "recovered"),
    ).toBe(0);
    expect(
      await readPostgresInsightsFirstMovementBucket(
        db,
        "00000000-0000-7000-8000-000000000099",
        "installed",
      ),
    ).toBeNull();
    expect(queries).toHaveLength(3);
    type Plan = {
      "Node Type": string;
      "Index Name"?: string;
      "Index Cond"?: string;
      "Actual Rows": number;
      "Actual Loops": number;
      "Rows Removed by Filter"?: number;
      "Heap Fetches"?: number;
      Plans?: Plan[];
    };
    for (const query of queries) {
      const result = await pool.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
        `explain (analyze, buffers, format json) ${query.sql}`,
        [...query.parameters],
      );
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(result.rows[0]!["QUERY PLAN"][0]!.Plan);
      process.stdout.write(
        JSON.stringify({
          query: query.sql,
          parameters: query.parameters,
          plan: result.rows[0]!["QUERY PLAN"],
        }) + "\n",
      );
      const index = nodes.find(
        (node) => node["Index Name"] === "insights_report_counts_bucket_idx",
      );
      expect(
        index,
        JSON.stringify({ query, plan: result.rows[0]!["QUERY PLAN"][0]!.Plan }),
      ).toBeDefined();
      expect(index!["Index Cond"]).toMatch(/job_id.+metric/);
      for (const node of nodes) {
        expect(node["Node Type"]).not.toMatch(/Seq Scan|Sort/);
        expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(
          1,
        );
        expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
        expect(node["Heap Fetches"] ?? 0).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each([jobsTable, headsTable])(
    "fails before publication metadata reads when %s loses its primary key",
    async (table) => {
      await append(1, asOfMs - 1);
      const query = { kind: "installationOverview" } as const;
      const publicationId = await reserve(query);
      await finish(query);
      const sourceGeneration = (
        await pool.query<{ source_generation: string }>(
          `select source_generation from ${jobsTable} where id=$1::uuid`,
          [publicationId],
        )
      ).rows[0]!.source_generation;
      await pool.query(`create temporary table metadata_noise as
      select ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid id,
        encode(sha256(convert_to('[1,'||to_json('[1,"activeOverview","7d","'||n::text||'"]')::text||']','UTF8')),'hex') query_key,
        json_build_object('kind','activeOverview','window','7d','userId',n::text) canonical_query
      from generate_series(0,50000)n;
      insert into ${headsTable}(query_key,canonical_query) select query_key,canonical_query from metadata_noise;`);
      await pool.query(
        `insert into ${jobsTable}(id,query_key,as_of_ms,status,source_generation,checkpoint)
        select id,query_key,0,'failed',$1,
          '{"phase":"source","shard":0,"afterSequence":"0"}'::jsonb from metadata_noise`,
        [sourceGeneration],
      );
      await pool.query(
        `analyze ${headsTable}; analyze ${jobsTable}; drop table metadata_noise`,
      );
      const input = {
        publicationId,
        section: "bundleDistribution",
        limit: 1,
      } as const;
      expect(await pages().pageReport(input)).toMatchObject({ state: "ready" });
      await pool.query(
        `alter table ${table} drop constraint ${table}_pkey cascade`,
      );
      pageQueries = [];
      await expect(pages().pageReport(input)).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
      expect(pageQueries.some((query) => /select\s+j\.\*/i.test(query))).toBe(
        false,
      );
      await expect(
        migratePostgresInsightsReports(db, insightsDatabaseNamespace),
      ).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
    },
  );
});
