import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import {
  getPostgresInsightsReportOrderReady,
  readPostgresInsightsReportOrderRange,
  stepPostgresInsightsReportOrder,
} from "./postgresInsightsReportOrder";

const counts = "private_hot_updater_insights_report_counts";
const runs = "private_hot_updater_insights_report_order_rows";
const jobId = "00000000-0000-0000-0000-000000000001";
const section = { section: "movementCohorts", metric: "installed" } as const;
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

describe("PostgreSQL report ordering native index bounds", () => {
  const container = `hot-updater-order-${randomUUID().slice(0, 8)}`;
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  let pool: pg.Pool;
  let db: Kysely<object>;

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
      "/var/lib/postgresql/data:rw,size=256m",
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
        throw new Error("PostgreSQL ordering fixture did not start.");
      await setTimeout(100);
    }
    pool = new pg.Pool({
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
    });
    db = new Kysely<object>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query")
          queries.push({
            sql: event.query.sql,
            parameters: event.query.parameters,
          });
      },
    });
    await pool.query(
      await readFile(
        "plugins/postgres/sql/insights-report-data-v1.sql",
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        "plugins/postgres/sql/insights-report-order-v1.sql",
        "utf8",
      ),
    );
    // Same job, unrelated section: a job-only PK scan would encounter these rows.
    await pool.query(`insert into ${counts}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      select '${jobId}'::uuid,encode(sha256(convert_to(identity,'UTF8')),'hex'),identity::jsonb,
        'activeBundleTotals','','unrelated-'||n::text,-1,50001-n
      from (select n,'["activeBundleTotals","","unrelated-'||n::text||'",-1]' identity from generate_series(0,50000)n)seed;
      insert into ${runs}(job_id,section,metric,sort_pass,run_number,row_position,label,value,count_key)
      select job_id,section,metric,0,((substring(label from 11))::bigint/32),((substring(label from 11))::bigint%32),label,value,count_key
      from ${counts};`);
  });
  afterAll(async () => {
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  it("uses bounded count-key and final-ordinal seeks with more than 50,000 unrelated rows and no read-time sort", async () => {
    const prefix = Array.from({ length: 96 }, (_, i) =>
      createHash("sha256").update(String(i)).digest("base64"),
    ).join("");
    const labels = Array.from(
      { length: 137 },
      (_, i) =>
        `${prefix}${["A", "a", "😀", "\ue000"][i % 4]}-${String(i).padStart(4, "0")}`,
    );
    await sql`insert into ${sql.table(counts)}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      values ${sql.join(
        labels.map((label) => {
          const identity = JSON.stringify([
            section.section,
            section.metric,
            label,
            -1,
          ]);
          return sql`(${jobId}::uuid,${createHash("sha256").update(identity).digest("hex")},${identity}::jsonb,${section.section},${section.metric},${label},-1,1)`;
        }),
      )}`.execute(db);
    await pool.query(`analyze ${counts}; analyze ${runs}`);
    queries.length = 0;
    await db
      .transaction()
      .execute((transaction) =>
        stepPostgresInsightsReportOrder(transaction, jobId, section),
      );
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
    const explain = async (
      query: { sql: string; parameters: readonly unknown[] },
      index: string,
      bound: number,
      connection: pg.Pool | pg.PoolClient = pool,
    ) => {
      const result = await connection.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`,
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
          plan: result.rows[0]!["QUERY PLAN"],
        }) + "\n",
      );
      expect(nodes.some((node) => node["Index Name"] === index)).toBe(true);
      for (const node of nodes) {
        expect(node["Node Type"]).not.toMatch(/Seq Scan|Sort/);
        expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(
          bound,
        );
        expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
      }
      return nodes;
    };
    await explain(copy, "insights_report_counts_order_input_idx", 32);
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      // Exercise prepared-statement planning, without disabling any scan method.
      await connection.query("set local plan_cache_mode = force_generic_plan");
      await connection.query(`prepare insights_order_copy as ${copy.sql}`);
      const nodes = await explain(
        {
          sql: `execute insights_order_copy(${copy.parameters.map((value) => pg.escapeLiteral(String(value))).join(",")})`,
          parameters: [],
        },
        "insights_report_counts_order_input_idx",
        32,
        connection,
      );
      expect(nodes.some((node) => node["Index Cond"]?.includes("$1"))).toBe(
        true,
      );
    } finally {
      await connection.query("rollback");
      connection.release();
    }
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++)
      ready = (
        await db
          .transaction()
          .execute((transaction) =>
            stepPostgresInsightsReportOrder(transaction, jobId, section),
          )
      ).ready;
    expect(ready).toBe(true);
    const metadata = (await getPostgresInsightsReportOrderReady(
      db,
      jobId,
      section,
    ))!;
    expect(metadata).toEqual({ pass: "3", totalRows: "137" });
    await pool.query(`analyze ${runs}`);
    queries.length = 0;
    const page = await readPostgresInsightsReportOrderRange(
      db,
      jobId,
      section,
      metadata.pass,
      "80",
      17,
    );
    expect(page.map((row) => row.label)).toEqual(
      [...labels].sort().slice(80, 97),
    );
    const range = queries.find(({ sql }) =>
      /order by row_position limit/.test(sql),
    )!;
    await explain(range, `${runs}_pkey`, 17);
    // A large matching section must remain a key seek too, not a top-N sort.
    const largeJobId = "00000000-0000-0000-0000-000000000002";
    await pool.query(`insert into ${counts}(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      select '${largeJobId}'::uuid,encode(sha256(convert_to(identity,'UTF8')),'hex'),identity::jsonb,
        'movementCohorts','installed','matching-'||n::text,-1,1
      from (select n,'["movementCohorts","installed","matching-'||n::text||'",-1]' identity from generate_series(0,50000)n)seed`);
    await pool.query(`analyze ${counts}`);
    for (let i = 0; i < 2; i++) {
      queries.length = 0;
      expect(
        await db
          .transaction()
          .execute((transaction) =>
            stepPostgresInsightsReportOrder(transaction, largeJobId, section),
          ),
      ).toEqual({ ready: false, processed: 32 });
      const boundedCopy = queries.find(({ sql }) =>
        /order by count_key limit/.test(sql),
      )!;
      await explain(boundedCopy, "insights_report_counts_order_input_idx", 32);
    }
    await pool.query("drop index insights_report_counts_order_input_idx");
    queries.length = 0;
    await expect(
      db
        .transaction()
        .execute((transaction) =>
          stepPostgresInsightsReportOrder(transaction, jobId, section),
        ),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(
      queries.some(({ sql }) => /order by (count_key|row_position)/.test(sql)),
    ).toBe(false);
  });
});
