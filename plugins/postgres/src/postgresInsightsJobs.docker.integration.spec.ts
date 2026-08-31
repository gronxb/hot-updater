import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";

const jobs = "private_hot_updater_insights_report_jobs";
const heads = "private_hot_updater_insights_report_heads";
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(50);
  }
  throw new Error(
    "PostgreSQL report fixture did not reach its expected state.",
  );
};

describe("PostgreSQL report reservation and lease concurrency", () => {
  const container = `hot-updater-jobs-${randomUUID().slice(0, 8)}`;
  let pool: pg.Pool;
  let db: Kysely<object>;
  let store: ReturnType<typeof createPostgresInsightsJobs>;

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
      "/var/lib/postgresql/data:rw,size=128m",
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:15-alpine",
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
    pool = new pg.Pool({
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
      max: 12,
      application_name: "insights-report-store",
    });
    db = new Kysely<object>({ dialect: new PostgresDialect({ pool }) });
    await pool.query(
      await readFile("plugins/postgres/sql/insights-reports-v1.sql", "utf8"),
    );
    await pool.query("create table derived_test(id integer primary key)");
    store = createPostgresInsightsJobs(db);
  });
  afterAll(async () => {
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  it("reserves one job across concurrent polls and never refills past a locked first candidate", async () => {
    const query = { kind: "installationOverview" } as const;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, minAsOfMs) =>
        store.getReport({ query, minAsOfMs }),
      ),
    );
    expect(results.every((result) => result.state === "queued")).toBe(true);
    expect(
      new Set(
        results.map((result) =>
          result.state === "queued" ? result.jobId : null,
        ),
      ).size,
    ).toBe(1);
    expect((await pool.query(`select id from ${jobs}`)).rows).toHaveLength(1);
    const reservations = (
      await Promise.all(Array.from({ length: 8 }, () => store.leaseNext()))
    ).filter((value) => value !== null);
    expect(reservations).toHaveLength(1);
    const first = reservations[0]!;
    expect(first.token.epoch).toBe("1");
    const next = await store.getReport({
      query: { kind: "activeOverview", window: "7d" },
    });
    expect(next.state).toBe("queued");
    await pool.query(
      `update ${jobs} set claimable_at=clock_timestamp()-interval '1 second' where id=$1`,
      [first.job.id],
    );
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query(`select id from ${jobs} where id=$1 for update`, [
        first.job.id,
      ]);
      expect(await store.leaseNext()).toBeNull();
      expect(
        (
          await pool.query(
            `select lease_epoch::text from ${jobs} where id <> $1`,
            [first.job.id],
          )
        ).rows,
      ).toEqual([{ lease_epoch: "0" }]);
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
    const second = (await store.leaseNext())!;
    expect(second.job.id).toBe(first.job.id);
    expect(second.token.epoch).toBe("2");
    const work = vi.fn();
    await expect(store.withLease(first.token, work)).rejects.toMatchObject({
      code: "INSIGHTS_LEASE_LOST",
    });
    expect(work).not.toHaveBeenCalled();
    await store.withLease(second.token, async () => ({ kind: "fail" }));
    const another = (await store.leaseNext())!;
    expect(another.job.id).not.toBe(first.job.id);
    await store.withLease(another.token, async () => ({ kind: "fail" }));
  });

  it("rechecks expiry after waiting for the publication head lock and rolls back derived output", async () => {
    await store.getReport({
      query: { kind: "bundleDetail", bundleId: "publish", window: "all" },
    });
    const lease = (await store.leaseNext())!;
    const generation = JSON.stringify([
      1,
      "00000000-0000-0000-0000-000000000001",
      Array(16).fill("0"),
    ]);
    // Preparation is covered through the public progress API in the unit suite.
    await pool.query(
      `update ${jobs} set source_generation=$2,checkpoint='{"phase":"complete"}'::jsonb,
      claimable_at=clock_timestamp()+interval '2 seconds' where id=$1`,
      [lease.job.id, generation],
    );
    const blocker = await pool.connect();
    let running: Promise<unknown> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query(
        `select query_key from ${heads} where active_job_id=$1 for update`,
        [lease.job.id],
      );
      running = store
        .withLease(lease.token, async (transaction) => {
          await sql`insert into derived_test values (1)`.execute(transaction);
          return {
            kind: "publish",
            summary: {
              kind: "bundleDetail",
              summary: { installed: 1, recovered: 0 },
            },
          };
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "select 1 from pg_stat_activity where application_name='insights-report-store' and wait_event_type='Lock' and query like $1",
              [`update "${heads}"%`],
            )
          ).rowCount === 1,
      );
      await setTimeout(2100);
      await blocker.query("rollback");
      expect(await running).toMatchObject({ code: "INSIGHTS_LEASE_LOST" });
      expect((await pool.query("select * from derived_test")).rows).toEqual([]);
      expect(
        (
          await pool.query(
            `select status,publication from ${jobs} where id=$1`,
            [lease.job.id],
          )
        ).rows,
      ).toEqual([{ status: "preparing", publication: null }]);
      expect(
        (
          await pool.query(
            `select publication_job_id from ${heads} where active_job_id=$1`,
            [lease.job.id],
          )
        ).rows,
      ).toEqual([{ publication_job_id: null }]);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await running;
    }
  });
});
