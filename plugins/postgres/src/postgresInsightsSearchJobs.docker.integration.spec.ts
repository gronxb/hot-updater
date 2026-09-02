import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { migratePostgresInsightsSource } from "./db";
import {
  createPostgresInsightsJobs,
  isPostgresInsightsContainsJob,
  type PostgresInsightsJobUpdate,
  type PostgresInsightsSearchResult,
} from "./postgresInsightsJobs";
import { createPostgresInsightsSourceTools } from "./postgresInsightsSource";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000f001";

const jobs = "private_hot_updater_insights_report_jobs";
const postgresImage =
  process.env.POSTGRES_INSIGHTS_TEST_VERSION_17 === "1"
    ? "postgres:17-alpine"
    : "postgres:15-alpine";
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(25);
  }
  throw new Error(
    "PostgreSQL search fixture did not reach its expected state.",
  );
};
const queuedId = (result: PostgresInsightsSearchResult) => {
  if (result.state !== "queued" && result.state !== "preparing")
    throw new Error("Expected a pending search.");
  return result.jobId;
};

describe("PostgreSQL search reservation and base publication concurrency", () => {
  const container = `hot-updater-search-jobs-${randomUUID().slice(0, 8)}`;
  let pool: pg.Pool;
  let db: Kysely<object>;
  let store: ReturnType<typeof createPostgresInsightsJobs>;
  let generation: string;
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
      "/var/lib/postgresql/data:rw,size=128m",
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      postgresImage,
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
      application_name: "insights-search-jobs",
    });
    db = new Kysely<object>({ dialect: new PostgresDialect({ pool }) });
    await pool.query(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    await migratePostgresInsightsSource(db, insightsDatabaseNamespace);
    const source = createPostgresInsightsSourceTools(
      db,
      insightsDatabaseNamespace,
    );
    await source.backfillStep(1);
    generation = await source.capture();
    await pool.query(
      await readFile("plugins/postgres/sql/insights-reports-v1.sql", "utf8"),
    );
    store = createPostgresInsightsJobs(db, insightsDatabaseNamespace);
  });
  afterAll(async () => {
    await db?.destroy();
    spawnSync("docker", ["rm", "--force", container]);
  });

  it("coalesces concurrent searches and commits a new FK pin while that base holds its publication lease", async () => {
    const reservations = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.getSearch({
          kind: "contains",
          query: i % 2 ? "FORMER" : "former",
          minAsOfMs: i,
        }),
      ),
    );
    const ids = new Set(reservations.map(queuedId));
    expect(ids.size).toBe(1);
    expect((await pool.query(`select id from ${jobs}`)).rowCount).toBe(2);
    const firstId = queuedId(reservations[0]!);
    const baseId: string = (
      await pool.query(`select base_job_id from ${jobs} where id=$1`, [firstId])
    ).rows[0].base_job_id;
    const acquire = async (id: string) => {
      // Prioritize only this fixture job, independent of machine/test duration.
      await pool.query(
        `update ${jobs} set claimable_at='-infinity'::timestamptz where id=$1`,
        [id],
      );
      const lease = await store.leaseNext();
      if (lease === null || lease.job.id !== id)
        throw new Error("Expected requested job lease.");
      return lease;
    };
    const update = async (next: PostgresInsightsJobUpdate) => {
      const lease = await acquire(baseId);
      await store.withLease(lease.token, async () => next);
    };
    for (let shard = 1; shard < 16; shard++)
      await update({
        kind: "progress",
        checkpoint: { phase: "source", shard, afterSequence: "0" },
      });
    await update({
      kind: "progress",
      checkpoint: { phase: "installations", afterInstallKey: null },
    });
    await update({
      kind: "progress",
      checkpoint: { phase: "ordering", section: 0 },
    });
    await update({ kind: "progress", checkpoint: { phase: "complete" } });
    const lease = await acquire(baseId);

    let enterWork!: () => void;
    let releaseWork!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterWork = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    // The real withLease transaction holds its base-job row lock here. A search
    // reservation then holds the global head and inserts an FK to that base.
    // FOR UPDATE would block the FK and deadlock when publication seeks the head.
    const publishing = store
      .withLease(lease.token, async () => {
        enterWork();
        await release;
        return {
          kind: "publish",
          summary: {
            kind: "installationOverview",
            summary: { trackedInstallations: 0 },
          },
        };
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await entered;
    let pinned: PostgresInsightsSearchResult | undefined;
    let pinError: unknown;
    const pinning = store
      .getSearch({ kind: "contains", query: "while publishing" })
      .then(
        (result) => {
          pinned = result;
        },
        (error: unknown) => {
          pinError = error;
        },
      );
    try {
      await waitUntil(
        async () =>
          pinned !== undefined ||
          pinError !== undefined ||
          (
            await pool.query(
              `select 1 from pg_stat_activity where application_name='insights-search-jobs'
          and wait_event_type='Lock' and query like $1`,
              [`insert into "${jobs}"%`],
            )
          ).rowCount === 1,
      );
      expect(pinError).toBeUndefined();
      // Assert pin commits before releasing the base worker, not just that a
      // deadlock victim eventually allowed one of two transactions to finish.
      expect(pinned).toMatchObject({ state: "queued" });
      const pinId = queuedId(pinned!);
      expect(
        (
          await pool.query(
            `select base_job_id,as_of_ms,source_generation from ${jobs} where id=$1`,
            [pinId],
          )
        ).rows,
      ).toEqual([
        { base_job_id: baseId, as_of_ms: null, source_generation: generation },
      ]);
    } finally {
      releaseWork();
      await pinning;
      expect(await publishing).toBeNull();
    }

    const pinId = queuedId(pinned!);
    const pinLease = await acquire(pinId);
    await store.withLease(pinLease.token, async () => ({
      kind: "bindIdentity",
    }));
    const rebound = await acquire(pinId);
    expect(isPostgresInsightsContainsJob(rebound.job)).toBe(true);
    expect(rebound.job).toMatchObject({
      baseJobId: baseId,
      sourceGeneration: generation,
      asOfMs: lease.job.asOfMs,
      checkpoint: { phase: "aliases", afterAliasKey: null },
    });
    // Isolate the base FK from the global publication head's separate reference.
    await pool.query(
      "update private_hot_updater_insights_report_heads set publication_job_id=null where publication_job_id=$1",
      [baseId],
    );
    await expect(
      pool.query(`delete from ${jobs} where id=$1`, [baseId]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (await pool.query(`select id from ${jobs} where id=$1`, [baseId]))
        .rowCount,
    ).toBe(1);
  });
});
