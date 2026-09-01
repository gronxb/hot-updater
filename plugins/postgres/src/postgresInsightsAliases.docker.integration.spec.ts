import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import {
  readPostgresInsightsAliasPage,
  savePostgresInsightsAliases,
} from "./postgresInsightsAliases";
import { readPostgresInsightsLatestByKey } from "./postgresInsightsReportData";

const table = "private_hot_updater_insights_report_aliases";
const latest = "private_hot_updater_insights_report_latest";
const jobId = "00000000-0000-0000-0000-000000000001";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const postgresImage =
  process.env.POSTGRES_INSIGHTS_TEST_VERSION_17 === "1"
    ? "postgres:17-alpine"
    : "postgres:15-alpine";
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

describe("PostgreSQL native historical alias bounds", () => {
  const container = `hot-updater-aliases-${randomUUID().slice(0, 8)}`;
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  let pool: pg.Pool;
  let db: Kysely<object>;
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
        throw new Error("PostgreSQL alias fixture did not start.");
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
      await readFile("plugins/postgres/sql/insights-aliases-v1.sql", "utf8"),
    );
    await pool.query(
      await readFile(
        "plugins/postgres/sql/insights-report-data-v1.sql",
        "utf8",
      ),
    );
    await pool.query(
      `insert into ${table}(job_id,alias_key,install_key,identity)
      select $1::uuid,encode(sha256(convert_to(identity,'UTF8')),'hex'),
        encode(sha256(convert_to(install_identity,'UTF8')),'hex'),identity::json
      from (select '["installation","install-'||n::text||'","install-'||n::text||'","install-'||n::text||'"]' identity,
        '"install-'||n::text||'"' install_identity from generate_series(0,50000)n)seed`,
      [jobId],
    );
    await pool.query(`analyze ${table}`);
  });
  afterAll(async () => {
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  type Plan = {
    "Node Type": string;
    "Actual Rows": number;
    "Actual Loops": number;
    "Index Name"?: string;
    "Index Cond"?: string;
    "Rows Removed by Filter"?: number;
    "Rows Removed by Index Recheck"?: number;
    "Lossy Heap Blocks"?: number;
    Plans?: Plan[];
  };
  const explain = async (
    query: { sql: string; parameters: readonly unknown[] },
    bound: number,
    indexes = [`${table}_pkey`],
    connection: pg.Pool | pg.PoolClient = pool,
  ) => {
    const result = await connection.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
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
      `${JSON.stringify({
        query: query.sql,
        plan: result.rows[0]!["QUERY PLAN"][0]!.Plan,
      })}\n`,
    );
    expect(
      nodes.some((node) => indexes.includes(node["Index Name"] ?? "")),
      JSON.stringify(result.rows),
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
      expect(node["Rows Removed by Index Recheck"] ?? 0).toBe(0);
      expect(node["Lossy Heap Blocks"] ?? 0).toBe(0);
    }
    expect(nodes.some((node) => node["Index Cond"]?.includes("job_id"))).toBe(
      true,
    );
    return nodes;
  };
  it("uses at most three indexed identity reads and bounded alias keyset pages among 50,001 historical aliases", async () => {
    const prefix = Array.from({ length: 12 }, (_, i) => hash(String(i))).join(
      "",
    );
    const row = {
      ...createBundleEventRowFixture("2", 2000),
      install_id: `target-${prefix}`,
      user_id: `User-${prefix}`,
      username: `İÉ ${prefix}`,
    };
    queries.length = 0;
    await db
      .transaction()
      .execute((tx) => savePostgresInsightsAliases(tx, jobId, row));
    const identityRead = queries.find(({ sql }) =>
      /alias_key in \(/.test(sql),
    )!;
    expect(identityRead).toBeDefined();
    await explain(identityRead, 3);
    await db
      .transaction()
      .execute((tx) => savePostgresInsightsAliases(tx, jobId, row));
    expect(
      (await pool.query(`select count(*)::integer as count from ${table}`))
        .rows,
    ).toEqual([{ count: 50_004 }]);

    const knownKeys = Array.from({ length: 50_001 }, (_, n) =>
      hash(
        JSON.stringify([
          "installation",
          `install-${n}`,
          `install-${n}`,
          `install-${n}`,
        ]),
      ),
    ).sort();
    for (const after of [null, knownKeys[199]!, knownKeys[49_983]!] as const) {
      queries.length = 0;
      const page = await readPostgresInsightsAliasPage(db, jobId, after, 200);
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(200);
      if (after !== null)
        expect(page.every((alias) => alias.aliasKey > after)).toBe(true);
      const read = queries.find(({ sql }) =>
        /order by alias_key limit/.test(sql),
      )!;
      await explain(read, 200);
    }
    const stored = (
      await pool.query<{ identity: [string, string, string, string] }>(
        `select identity from ${table} where job_id=$1::uuid and alias_key=$2`,
        [
          jobId,
          hash(
            JSON.stringify([
              "username",
              row.username.toLowerCase(),
              row.username,
              row.install_id,
            ]),
          ),
        ],
      )
    ).rows[0]!;
    expect(stored.identity[1]).toBe(row.username.toLowerCase());
    await pool.query(`alter table ${table} drop constraint ${table}_pkey`);
    queries.length = 0;
    await expect(
      readPostgresInsightsAliasPage(db, jobId, null, 200),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(
      queries.some(({ sql }) => /order by alias_key limit/.test(sql)),
    ).toBe(false);
  });

  it("resolves 200 frozen latest hash points through either exact native index under custom and generic plans", async () => {
    await pool.query(
      `insert into ${latest}(job_id,install_key,bucket_index,install_id,event)
      select $1::uuid,encode(sha256(convert_to(to_json(install_id)::text,'UTF8')),'hex'),-1,install_id,
        $2::jsonb || jsonb_build_object('install_id',install_id,'received_at_ms',n+1000,
          'id','00000000-0000-7000-8000-'||lpad(n::text,12,'0'))
      from (select n,'latest-'||n::text install_id from generate_series(0,50000)n)fixture`,
      [jobId, JSON.stringify(createBundleEventRowFixture("1", 1000))],
    );
    const requestedIds = Array.from(
      { length: 200 },
      (_, i) => `latest-${37 + i * 250}`,
    ).reverse();
    const requestedKeys = requestedIds.map((id) => hash(JSON.stringify(id)));
    // The same hashes in another bucket/publication must not add candidates.
    await pool.query(
      `insert into ${latest}(job_id,install_key,bucket_index,install_id,event)
      select job_id,install_key,0,install_id,event from ${latest}
      where job_id=$1::uuid and install_key=any($2::text[])`,
      [jobId, requestedKeys],
    );
    await pool.query(
      `insert into ${latest}(job_id,install_key,bucket_index,install_id,event)
      select '00000000-0000-0000-0000-000000000002'::uuid,install_key,-1,install_id,event
      from ${latest} where job_id=$1::uuid and bucket_index=-1 and install_key=any($2::text[])`,
      [jobId, requestedKeys],
    );
    await pool.query(`analyze ${latest}`);
    queries.length = 0;
    const rows = await readPostgresInsightsLatestByKey(
      db,
      jobId,
      requestedKeys,
    );
    expect(rows.map((row) => row.event.install_id)).toEqual(requestedIds);
    expect(queries).toHaveLength(3);
    expect(/bundle_events|order by|offset/i.test(queries.at(-1)!.sql)).toBe(
      false,
    );
    const lookup = queries.find(({ sql }) => /install_key in \(/.test(sql))!;
    expect(lookup).toBeDefined();
    const indexes = [
      `${latest}_pkey`,
      "insights_report_latest_installations_idx",
    ];
    const custom = await explain(lookup, 200, indexes);
    const checkPoints = (nodes: Plan[]) => {
      const scans = nodes.filter((node) => node["Index Name"] !== undefined);
      expect(scans.length).toBeGreaterThan(0);
      for (const node of scans) {
        expect(node["Index Cond"]).toContain("job_id");
        expect(node["Index Cond"]).toContain("bucket_index");
        expect(node["Index Cond"]).toContain("install_key");
      }
    };
    checkPoints(custom);
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      // Generic prepared plans still have to push all 200 hash points into the index.
      await connection.query("set local plan_cache_mode = force_generic_plan");
      await connection.query(`prepare insights_latest_points as ${lookup.sql}`);
      const generic = await explain(
        {
          sql: `execute insights_latest_points(${lookup.parameters.map((value) => pg.escapeLiteral(String(value))).join(",")})`,
          parameters: [],
        },
        200,
        indexes,
        connection,
      );
      checkPoints(generic);
      expect(generic.some((node) => node["Index Cond"]?.includes("$1"))).toBe(
        true,
      );
    } finally {
      await connection.query("rollback");
      connection.release();
    }
  });
});
