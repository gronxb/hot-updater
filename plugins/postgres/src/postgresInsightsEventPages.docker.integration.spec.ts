import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { postgres } from "./postgres";
import { migratePostgresInsightsInstallationEvents } from "./postgresInsightsEventMigration";

const bundleId = "00000000-0000-0000-0000-000000000001";
const postgresImages = [
  "postgres:15-alpine",
  ...(process.env.HOT_UPDATER_POSTGRES_17_TESTS === "1"
    ? (["postgres:17-alpine"] as const)
    : []),
] as const;
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
type Plan = {
  "Node Type": string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: Plan[];
};
const nodes = (plan: Plan): Plan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

describe.each(postgresImages)(
  "PostgreSQL native installation movement pages (%s)",
  (image) => {
    const container = `hot-updater-event-pages-${randomUUID().slice(0, 8)}`;
    const clients: pg.PoolClient[] = [];
    let pool: pg.Pool;
    let db: Kysely<object>;
    let plugin: ReturnType<typeof postgres>;
    const statements = () =>
      clients
        .flatMap((client) => vi.mocked(client.query).mock.calls)
        .map((args) => ({
          sql: args[0] as unknown as string,
          parameters: Array.isArray(args[1]) ? (args[1] as unknown[]) : [],
        }))
        .filter((query) => typeof query.sql === "string");
    const clear = () => {
      for (const client of clients) vi.mocked(client.query).mockClear();
    };
    const eventReads = () =>
      statements().filter(({ sql }) => sql.includes('from "bundle_events"'));
    beforeAll(async () => {
      docker(["image", "inspect", image]);
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
          throw new Error("PostgreSQL event-page fixture did not start.");
        await setTimeout(100);
      }
      pool = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        database: "postgres",
        max: 4,
      });
      pool.on("connect", (client) => {
        vi.spyOn(client, "query");
        clients.push(client);
      });
      db = new Kysely<object>({ dialect: new PostgresDialect({ pool }) });
      plugin = postgres({ dialect: new PostgresDialect({ pool }) });
      await pool.query(
        await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
      );
      await pool.query(`insert into bundle_events(id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
        case when n%2=0 then 'UNCHANGED' else 'RELEASE_ADOPTED' end,
        'target', case when n%2=0 then null else '${bundleId}' end::uuid,
        '${bundleId}', 'ios','1.0.0','production','default',
        case when n%2=0 then null else 'appVersion' end,70000+n
      from generate_series(0,50000)n;
      insert into bundle_events(id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
        case when n%2=0 then 'UPDATE_APPLIED' else 'RECOVERED' end,
        'target', '${bundleId}', '${bundleId}', 'ios','1.0.0','production','default','appVersion',
        case when n<4 then 59999 else 60000 end
      from generate_series(0,106)n;
      analyze bundle_events;`);
      // The other caller may complete after the first or fail fast as busy. It
      // must not hold an old SELECT snapshot while awaiting the migration lock.
      const migrations = await Promise.allSettled([
        migratePostgresInsightsInstallationEvents(db),
        migratePostgresInsightsInstallationEvents(db),
      ]);
      expect(migrations.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      for (const result of migrations)
        if (result.status === "rejected")
          expect(result.reason.message).toBe(
            "Installation event migration is already running.",
          );
      await migratePostgresInsightsInstallationEvents(db);
      await pool.query("analyze bundle_events");
      clear();
    });
    afterAll(async () => {
      await pool?.end();
      spawnSync("docker", ["rm", "-f", container]);
    });
    const explain = async (
      query: { sql: string; parameters: unknown[] },
      bound: number,
      connection: pg.Pool | pg.PoolClient = pool,
    ) => {
      const result = await connection.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
        `explain (analyze,buffers,format json) ${query.sql}`,
        query.parameters,
      );
      const plan = result.rows[0]!["QUERY PLAN"][0]!.Plan;
      process.stdout.write(`${JSON.stringify({ query: query.sql, plan })}\n`);
      const flat = nodes(plan);
      expect(
        flat.some((node) =>
          [
            "bundle_events_install_applied_idx",
            "bundle_events_install_recovered_idx",
          ].includes(node["Index Name"] ?? ""),
        ),
        JSON.stringify(plan),
      ).toBe(true);
      for (const node of flat) {
        expect(node["Node Type"], JSON.stringify(plan)).not.toMatch(
          /Seq Scan|Sort/,
        );
        expect(
          node["Actual Rows"] * node["Actual Loops"],
          JSON.stringify(plan),
        ).toBeLessThanOrEqual(bound);
        expect(node["Rows Removed by Filter"] ?? 0, JSON.stringify(plan)).toBe(
          0,
        );
        expect(node["Rows Removed by Index Recheck"] ?? 0).toBe(0);
      }
      return flat;
    };
    it("uses literal partial-index predicates for custom and generic plans among 50,001 same-install activity events", async () => {
      const input = {
        scope: { kind: "installation", installId: "target" },
        sinceReceivedAtMs: 60000,
        beforeReceivedAtMs: 130001,
        limit: 17,
      } as const;
      clear();
      const first = await plugin.models.insights.events!.page(input);
      expect(first.rows.map(({ id }) => id)).toEqual(
        Array.from(
          { length: 17 },
          (_, n) =>
            `20000000-0000-0000-0000-${String(106 - n).padStart(12, "0")}`,
        ),
      );
      const second = await plugin.models.insights.events!.page({
        ...input,
        cursor: first.nextCursor!,
      });
      expect(second.rows.map(({ id }) => id)).toEqual(
        Array.from(
          { length: 17 },
          (_, n) =>
            `20000000-0000-0000-0000-${String(89 - n).padStart(12, "0")}`,
        ),
      );
      const reads = eventReads();
      expect(reads).toHaveLength(4);
      for (const [index, read] of reads.entries()) {
        expect(read.sql).toMatch(/type = '(UPDATE_APPLIED|RECOVERED)'/);
        await explain(read, 18);
        const connection = await pool.connect();
        try {
          await connection.query("begin");
          await connection.query(
            "set local plan_cache_mode=force_generic_plan",
          );
          await connection.query(`prepare movement_${index} as ${read.sql}`);
          const flat = await explain(
            {
              sql: `execute movement_${index}(${read.parameters.map((value) => pg.escapeLiteral(String(value))).join(",")})`,
              parameters: [],
            },
            18,
            connection,
          );
          expect(flat.some((node) => node["Index Cond"]?.includes("$1"))).toBe(
            true,
          );
        } finally {
          await connection.query("rollback");
          connection.release();
        }
      }
      let cursor = second.nextCursor;
      const ids = [...first.rows, ...second.rows].map(({ id }) => id);
      while (cursor !== null) {
        const page = await plugin.models.insights.events!.page({
          ...input,
          cursor,
          limit: 1,
        });
        ids.push(...page.rows.map(({ id }) => id));
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(
        Array.from(
          { length: 103 },
          (_, n) =>
            `20000000-0000-0000-0000-${String(106 - n).padStart(12, "0")}`,
        ),
      );
    });
    it("rejects missing, incorrect-predicate, and nondeterministic-collation indexes before raw queries", async () => {
      const input = {
        scope: { kind: "installation", installId: "target" },
        beforeReceivedAtMs: 130001,
        limit: 1,
      } as const;
      await pool.query("drop index bundle_events_install_applied_idx");
      clear();
      await expect(
        plugin.models.insights.events!.page(input),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      await expect(
        migratePostgresInsightsInstallationEvents(db),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(eventReads()).toEqual([]);
      await pool.query(
        "create index bundle_events_install_applied_idx on bundle_events(install_id,received_at_ms,id) where type='UNCHANGED'",
      );
      clear();
      await expect(
        plugin.models.insights.events!.page(input),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(eventReads()).toEqual([]);
      await pool.query(
        "drop index bundle_events_install_applied_idx;drop index bundle_events_install_recovered_idx",
      );
      await migratePostgresInsightsInstallationEvents(db);
      await pool.query(
        "create collation event_casefold (provider=icu, locale='und-u-ks-level2', deterministic=false)",
      );
      await pool.query(
        "alter table bundle_events alter column install_id type text collate event_casefold",
      );
      clear();
      await expect(
        plugin.models.insights.events!.page(input),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(eventReads()).toEqual([]);
      await pool.query(
        'alter table bundle_events alter column install_id type text collate "default"',
      );
    });

    it("preserves existing admitted index-key widths and escaped identities without replacement matches", async () => {
      const nearWidth = Array.from({ length: 42 }, (_, index) =>
        createHash("sha256").update(String(index)).digest("hex"),
      )
        .join("")
        .slice(0, 2660);
      for (const installId of ["", nearWidth, '\\"😀'.repeat(4000), "\uFFFD"]) {
        const ids = [randomUUID(), randomUUID()].sort().reverse();
        for (const [index, id] of ids.entries())
          await pool.query(
            `insert into bundle_events(id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
          values($1::uuid,$2,$3,$4::uuid,$4::uuid,'ios','1.0.0','production','default','appVersion',60000)`,
            [
              id,
              index === 0 ? "UPDATE_APPLIED" : "RECOVERED",
              installId,
              bundleId,
            ],
          );
        const input = {
          scope: { kind: "installation", installId },
          beforeReceivedAtMs: 60001,
          limit: 1,
        } as const;
        const first = await plugin.models.insights.events!.page(input);
        const last = await plugin.models.insights.events!.page({
          ...input,
          cursor: first.nextCursor!,
        });
        expect([...first.rows, ...last.rows].map(({ id }) => id)).toEqual(ids);
        expect(last.nextCursor).toBeNull();
      }
      clear();
      for (const installId of ["\0", "\uD800", "\uDC00"])
        expect(
          await plugin.models.insights.events!.page({
            scope: { kind: "installation", installId },
            beforeReceivedAtMs: 60001,
            limit: 1,
          }),
        ).toEqual({ rows: [], nextCursor: null });
      expect(eventReads()).toEqual([]);
    });

    it("fails fast when another migration owns the lock and succeeds on an explicit retry", async () => {
      const holder = await pool.connect();
      try {
        await holder.query(
          "select pg_advisory_lock(hashtext('hot-updater:insights-installation-events:v1'))",
        );
        clear();
        await expect(
          migratePostgresInsightsInstallationEvents(db),
        ).rejects.toThrow("already running");
        expect(statements()).toHaveLength(1);
        expect(statements()[0]?.sql).toContain("pg_try_advisory_lock");
      } finally {
        await holder.query(
          "select pg_advisory_unlock(hashtext('hot-updater:insights-installation-events:v1'))",
        );
        holder.release();
      }
      await migratePostgresInsightsInstallationEvents(db);
    });

    it("does not scan a newer unrelated movement burst while statistics still describe one installation", async () => {
      await pool.query(`truncate bundle_events;
      insert into bundle_events(id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select ('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
        'UPDATE_APPLIED',
        'target', '${bundleId}', '${bundleId}', 'ios','1.0.0','production','default','appVersion',n
      from generate_series(0,50002)n;
      analyze bundle_events;
      insert into bundle_events(id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select ('50000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
        'UPDATE_APPLIED',
        'newer-unrelated', '${bundleId}', '${bundleId}', 'ios','1.0.0','production','default','appVersion',60000+n
      from generate_series(0,50002)n;`);
      clear();
      const page = await plugin.models.insights.events!.page({
        scope: { kind: "installation", installId: "target" },
        beforeReceivedAtMs: 130001,
        limit: 1,
      });
      expect(page.rows[0]?.id).toBe("40000000-0000-0000-0000-000000050002");
      const reads = eventReads();
      expect(reads).toHaveLength(2);
      for (const [index, read] of reads.entries()) {
        await explain(read, 2);
        const connection = await pool.connect();
        try {
          await connection.query("begin");
          await connection.query(
            "set local plan_cache_mode=force_generic_plan",
          );
          await connection.query(
            `prepare lag_movement_${index} as ${read.sql}`,
          );
          await explain(
            {
              sql: `execute lag_movement_${index}(${read.parameters.map((value) => pg.escapeLiteral(String(value))).join(",")})`,
              parameters: [],
            },
            2,
            connection,
          );
        } finally {
          await connection.query("rollback");
          connection.release();
        }
      }
    });
  },
);
