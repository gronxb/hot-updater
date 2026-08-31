import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { createPostgresInsightsInstallationLookup } from "./postgresInsightsInstallation";

const eventId = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
const bundleId = "11111111-1111-1111-1111-111111111111";
const identities = [
  "",
  "Case",
  "case",
  "É",
  "E\u0301",
  "\u{10000}",
  "\ue000",
  "\ufffd",
  "漢😀".repeat(1600),
];
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
type Query = { sql: string; parameters: readonly unknown[] };
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

describe.each(["postgres:15-alpine", "postgres:17-alpine"])(
  "native exact installation lookup on %s",
  (postgresImage) => {
    const container = `hot-updater-installation-${randomUUID().slice(0, 8)}`;
    let pool: pg.Pool;
    let db: Kysely<object>;
    let lookup: ReturnType<typeof createPostgresInsightsInstallationLookup>;
    let queries: Query[] = [];
    let returnedRows = 0;
    let injectAtObservation:
      | ((observedAtMs: number) => Promise<void>)
      | undefined;

    const insert = async (
      number: number,
      installId: string,
      receivedAtMs: number,
      type = "UNCHANGED",
    ) => {
      await pool.query(
        `insert into bundle_events(id,type,install_id,from_bundle_id,to_bundle_id,
        platform,app_version,channel,cohort,update_strategy,received_at_ms)
      values($1::uuid,$2,$3,case when $2='UNCHANGED' then null else $4::uuid end,
        $4::uuid,'ios','1.0.0','production','cohort',
        case when $2='UNCHANGED' then null else 'appVersion' end,$5)`,
        [eventId(number), type, installId, bundleId, receivedAtMs],
      );
    };
    const read = async (installId: string, limit = 100) => {
      queries = [];
      returnedRows = 0;
      const result = await lookup.pageInstallation({
        kind: "installation",
        installId,
        limit,
      });
      if (result.state !== "ready" || result.consistency !== "live")
        throw new Error("Expected a live exact installation page.");
      expect(result.nextCursor).toBeNull();
      expect(result.rows.length).toBeLessThanOrEqual(1);
      expect(result).not.toHaveProperty("publication");
      expect(result).not.toHaveProperty("total");
      return result;
    };
    const rawQueries = () =>
      queries.filter(({ sql }) => /from bundle_events\b/i.test(sql));

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
          throw new Error("PostgreSQL exact lookup fixture did not start.");
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
          queries.push({
            sql: event.query.sql,
            parameters: event.query.parameters,
          });
        },
        plugins: [
          {
            transformQuery: ({ node }) => node,
            async transformResult({ result }) {
              returnedRows += result.rows.length;
              const first = result.rows[0] as
                | { observed_at_ms?: number }
                | undefined;
              if (injectAtObservation && first?.observed_at_ms !== undefined) {
                const inject = injectAtObservation;
                injectAtObservation = undefined;
                // Separate ingestion after the actual DB observation, before its
                // indexed data query. These writes are outside the reader budget.
                await inject(first.observed_at_ms);
              }
              return result;
            },
          },
        ],
      });
      lookup = createPostgresInsightsInstallationLookup(db);
      await pool.query(
        await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
      );
      await pool.query(
        "alter table bundle_events add column private_note text default 'not-public'",
      );
      await pool.query(`insert into bundle_events(id,type,install_id,to_bundle_id,
      platform,app_version,channel,cohort,received_at_ms)
      select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
        'UNCHANGED','busy','${bundleId}'::uuid,'ios','1.0.0','production','cohort',n
      from generate_series(1,50003)n`);
      await insert(50004, "busy", 50003, "UPDATE_APPLIED");
      await insert(50005, "busy", 50003, "RELEASE_ADOPTED");
      await insert(50006, "busy", 50003, "RECOVERED");
      await insert(50007, "busy", Number.MAX_SAFE_INTEGER);
      for (const [index, installId] of identities.entries())
        await insert(61000 + index, installId, 10);
      await pool.query("analyze bundle_events");
      // A newer unrelated burst makes time-index filtering observable; merely
      // finding one recent matching row would not prove a bounded identity seek.
      await pool.query(`insert into bundle_events(id,type,install_id,to_bundle_id,
      platform,app_version,channel,cohort,received_at_ms)
      select ('00000000-0000-0000-0000-'||lpad((n+90000)::text,12,'0'))::uuid,
        'UNCHANGED','other-busy','${bundleId}'::uuid,'ios','1.0.0','production','cohort',1000000+n
      from generate_series(1,50003)n`);
    });
    afterAll(async () => {
      await db?.destroy();
      spawnSync("docker", ["rm", "--force", container]);
    });

    const explain = async (
      query: Query,
      expectedRows: 0 | 1,
      connection: pg.Pool | pg.PoolClient = pool,
    ) => {
      const result = await connection.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
        `explain (analyze,buffers,format json) ${query.sql}`,
        [...query.parameters],
      );
      const plan = result.rows[0]!["QUERY PLAN"][0]!.Plan;
      process.stdout.write(
        `${JSON.stringify({ postgresImage, query: query.sql, parameters: query.parameters, plan })}\n`,
      );
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      expect(plan["Actual Rows"]).toBe(expectedRows);
      expect(
        nodes.some(
          (node) => node["Index Name"] === "bundle_events_install_idx",
        ),
      ).toBe(true);
      expect(
        nodes.some(
          (node) =>
            node["Index Cond"]?.includes("install_id") &&
            node["Index Cond"]?.includes("received_at_ms"),
        ),
      ).toBe(true);
      for (const node of nodes) {
        expect(node["Node Type"], JSON.stringify(node)).not.toMatch(
          /Seq Scan|Sort|Bitmap/,
        );
        expect(
          node["Actual Rows"] * node["Actual Loops"],
          JSON.stringify(node),
        ).toBeLessThanOrEqual(expectedRows);
        expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
        expect(node["Rows Removed by Index Recheck"] ?? 0).toBe(0);
        expect(node["Lossy Heap Blocks"] ?? 0).toBe(0);
      }
      return nodes;
    };

    it("seeks one latest tuple or zero rows among over50,001 same-install events with custom and generic plans", async () => {
      for (const [installId, expectedRows] of [
        ["busy", 1],
        ["missing", 0],
      ] as const) {
        const result = await read(installId);
        expect(result.rows).toHaveLength(expectedRows);
        expect(queries).toHaveLength(2);
        expect(returnedRows).toBe(1 + expectedRows);
        expect(rawQueries()).toHaveLength(1);
        expect(queries.every(({ sql }) => !/\boffset\b/i.test(sql))).toBe(true);
        if (expectedRows === 1) {
          expect(result.rows[0]).toMatchObject({
            id: eventId(50006),
            type: "RECOVERED",
            received_at_ms: 50003,
          });
          expect(Object.keys(result.rows[0]!).sort()).toEqual(
            [
              "id",
              "install_id",
              "user_id",
              "username",
              "to_bundle_id",
              "type",
              "platform",
              "app_version",
              "channel",
              "cohort",
              "received_at_ms",
            ].sort(),
          );
        }
        const raw = rawQueries()[0]!;
        await explain(raw, expectedRows);
        const connection = await pool.connect();
        try {
          await connection.query("begin");
          await connection.query(
            "set local plan_cache_mode=force_generic_plan",
          );
          await connection.query(`prepare exact_installation as ${raw.sql}`);
          const nodes = await explain(
            {
              sql: `execute exact_installation(${raw.parameters.map((value) => pg.escapeLiteral(String(value))).join(",")})`,
              parameters: [],
            },
            expectedRows,
            connection,
          );
          expect(
            nodes.some(
              (node) =>
                node["Index Cond"]?.includes("$1") &&
                node["Index Cond"]?.includes("$2"),
            ),
          ).toBe(true);
        } finally {
          await connection.query("rollback");
          await connection.query("deallocate all");
          connection.release();
        }
      }
    });

    it("uses the observed cutoff strictly even when equal-time and future events commit before the data query", async () => {
      let captured = -1;
      injectAtObservation = async (observedAtMs) => {
        captured = observedAtMs;
        await insert(60001, "cutoff", observedAtMs - 1, "RELEASE_ADOPTED");
        await insert(60002, "cutoff", observedAtMs);
        await insert(60003, "cutoff", observedAtMs + 1, "RECOVERED");
      };
      const result = await read("cutoff", 1);
      expect(result.observedAtMs).toBe(captured);
      expect(result.rows).toMatchObject([
        {
          id: eventId(60001),
          type: "RELEASE_ADOPTED",
          received_at_ms: captured - 1,
        },
      ]);
      expect(queries).toHaveLength(2);
      expect(returnedRows).toBe(2);
      await explain(rawQueries()[0]!, 1);
    });

    it("preserves empty, long and exact Unicode identities without rewriting unrepresentable queries", async () => {
      for (const [index, installId] of identities.entries()) {
        const result = await read(installId);
        expect(result.rows).toMatchObject([
          {
            id: eventId(61000 + index),
            install_id: installId,
            type: "UNCHANGED",
          },
        ]);
        expect(queries).toHaveLength(2);
        expect(returnedRows).toBe(2);
      }
      for (const installId of ["\ud800", "\udfff", "\u0000", "a\ud800b"]) {
        const result = await read(installId);
        expect(result.rows).toEqual([]);
        expect(queries).toHaveLength(1);
        expect(returnedRows).toBe(1);
        expect(rawQueries()).toEqual([]);
      }
    });

    it("detects a dropped index after a successful lookup before issuing any raw query", async () => {
      expect((await read("busy")).rows).toHaveLength(1);
      await pool.query("drop index bundle_events_install_idx");
      try {
        await expect(read("busy")).rejects.toMatchObject({
          code: "INSIGHTS_QUERY_NOT_READY",
        });
        expect(queries).toHaveLength(1);
        expect(returnedRows).toBe(1);
        expect(rawQueries()).toEqual([]);
      } finally {
        await pool.query(
          "create index bundle_events_install_idx on bundle_events(install_id,received_at_ms,id)",
        );
      }
      expect((await read("busy")).rows).toHaveLength(1);
    });

    it("accepts matching deterministic ICU equality and rejects nondeterministic or mismatched collation before raw reads", async () => {
      // This is an actual ICU test. An image without ICU must fail visibly rather
      // than silently passing and being reported as nondeterministic coverage.
      await pool.query(
        "create collation exact_deterministic(provider=icu,locale='und-u-ks-level2',deterministic=true)",
      );
      await pool.query(
        "create collation exact_nondeterministic(provider=icu,locale='und-u-ks-level2',deterministic=false)",
      );
      try {
        await pool.query(
          'alter table bundle_events alter column install_id type text collate "exact_deterministic"',
        );
        expect((await read("Case")).rows[0]?.install_id).toBe("Case");
        expect((await read("case")).rows[0]?.install_id).toBe("case");
        expect((await read("É")).rows[0]?.install_id).toBe("É");
        expect((await read("E\u0301")).rows[0]?.install_id).toBe("E\u0301");
        await pool.query("drop index bundle_events_install_idx");
        await pool.query(
          'create index bundle_events_install_idx on bundle_events(install_id collate "C",received_at_ms,id)',
        );
        await expect(read("Case")).rejects.toMatchObject({
          code: "INSIGHTS_QUERY_NOT_READY",
        });
        expect(rawQueries()).toEqual([]);
        await pool.query("drop index bundle_events_install_idx");
        await pool.query(
          "create index bundle_events_install_idx on bundle_events(install_id,received_at_ms,id)",
        );
        await pool.query(
          'alter table bundle_events alter column install_id type text collate "exact_nondeterministic"',
        );
        expect(
          (
            await pool.query(
              "select 'Case' collate \"exact_nondeterministic\" = 'case' as equal",
            )
          ).rows[0].equal,
        ).toBe(true);
        await expect(read("Case")).rejects.toMatchObject({
          code: "INSIGHTS_QUERY_NOT_READY",
        });
        expect(queries).toHaveLength(1);
        expect(rawQueries()).toEqual([]);
      } finally {
        await pool.query(
          'alter table bundle_events alter column install_id type text collate "default"',
        );
      }
      expect((await read("busy")).rows[0]?.id).toBe(eventId(50006));
    });

    it("rejects corrupt selected metadata without retrying older history or failing an unrelated installation", async () => {
      await insert(62000, "corrupt", 1);
      // Simulate a damaged legacy table, not a write through today's constraints.
      await pool.query(
        "alter table bundle_events drop constraint bundle_events_platform_check",
      );
      await pool.query(
        "update bundle_events set platform='invalid-platform' where id=$1::uuid",
        [eventId(62000)],
      );
      await expect(read("corrupt")).rejects.toMatchObject({
        code: "invalid-result",
      });
      expect(queries).toHaveLength(2);
      expect(returnedRows).toBe(2);
      expect(rawQueries()).toHaveLength(1);
      expect((await read("busy")).rows[0]?.id).toBe(eventId(50006));
    });
  },
);
