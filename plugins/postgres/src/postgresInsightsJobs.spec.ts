import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type {
  InsightsReportInput,
  InsightsReportQuery,
} from "@hot-updater/plugin-core";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPostgresInsightsJobs,
  isPostgresInsightsContainsJob,
  readPostgresInsightsReportPublication,
  type PostgresInsightsReportCheckpoint,
} from "./postgresInsightsJobs";

const headTable = "private_hot_updater_insights_report_heads";
const jobTable = "private_hot_updater_insights_report_jobs";
const generation = JSON.stringify([
  1,
  "00000000-0000-0000-0000-000000000001",
  Array(16).fill("2"),
]);
const initial: PostgresInsightsReportCheckpoint = {
  phase: "source",
  shard: 0,
  afterSequence: "0",
};

describe("PostgreSQL durable report jobs", () => {
  let client: PGlite;
  let db: Kysely<object>;
  let store: ReturnType<typeof createPostgresInsightsJobs>;
  const query: InsightsReportQuery = { kind: "installationOverview" };
  const saved = async () =>
    (
      await client.query<{
        id: string;
        as_of_ms: number;
        status: string;
        source_generation: string | null;
        checkpoint: PostgresInsightsReportCheckpoint;
      }>(`select * from ${jobTable}`)
    ).rows;
  const acquire = async () => {
    const lease = await store.leaseNext();
    expect(lease).not.toBeNull();
    if (lease === null || isPostgresInsightsContainsJob(lease.job))
      throw new Error("Expected a report lease.");
    return { ...lease, job: lease.job };
  };
  const sourceComplete = async (captured = generation) => {
    for (let shard = 0; shard < 16; shard++) {
      const lease = await acquire();
      await store.withLease(lease.token, async () => ({
        kind: "progress",
        sourceGeneration: captured,
        checkpoint: { phase: "source", shard, afterSequence: "0" },
      }));
    }
    return acquire();
  };
  const complete = async (captured = generation) => {
    let lease = await sourceComplete(captured);
    if (
      lease.job.query.kind === "installationOverview" ||
      lease.job.query.kind === "activeOverview"
    ) {
      await store.withLease(lease.token, async () => ({
        kind: "progress",
        checkpoint: { phase: "installations", afterInstallKey: null },
      }));
      lease = await acquire();
    }
    const sections =
      lease.job.query.kind === "bundleSummaries"
        ? 0
        : lease.job.query.kind === "installationOverview"
          ? 1
          : 2;
    for (let section = 0; section < sections; section++) {
      await store.withLease(lease.token, async () => ({
        kind: "progress",
        checkpoint: { phase: "ordering", section },
      }));
      lease = await acquire();
    }
    await store.withLease(lease.token, async () => ({
      kind: "progress",
      checkpoint: { phase: "complete" },
    }));
    return acquire();
  };

  beforeEach(async () => {
    client = new PGlite();
    // Deliberately no raw event or source clock tables: requests cannot depend on them.
    await client.exec(
      await readFile("plugins/postgres/sql/insights-reports-v1.sql", "utf8"),
    );
    await client.exec(
      "create table derived_test (id integer primary key, value integer not null)",
    );
    db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    store = createPostgresInsightsJobs(db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("reuses the same durable job across canonical variants, polling and freshness changes without source reads", async () => {
    const requests = Array.from(
      { length: 20 },
      (_, i): InsightsReportInput => ({
        query: {
          kind: "bundleSummaries",
          bundleIds: i % 2 ? ["b", "a", "a"] : ["a", "b"],
          window: "7d",
        },
        minAsOfMs: i,
      }),
    );
    const results = await Promise.all(
      requests.map((request) => store.getReport(request)),
    );
    expect(results.every((result) => result.state === "queued")).toBe(true);
    expect(
      new Set(
        results.map((result) =>
          result.state === "queued" ? result.jobId : null,
        ),
      ).size,
    ).toBe(1);
    const before = await saved();
    expect(before).toHaveLength(1);
    expect(before[0]!.source_generation).toBeNull();
    const lease = await acquire();
    expect(lease.job.query).toEqual({
      kind: "bundleSummaries",
      bundleIds: ["a", "b"],
      window: "7d",
    });
    expect(await store.getReport(requests[0]!)).toMatchObject({
      state: "preparing",
      jobId: lease.job.id,
    });
    expect((await saved())[0]!.as_of_ms).toBe(before[0]!.as_of_ms);
    expect(await store.leaseNext()).toBeNull();
  });

  it("rejects invalid or future requests without reserving a job and detects a stored hash/query mismatch", async () => {
    await expect(
      store.getReport({ query, minAsOfMs: Number.MAX_SAFE_INTEGER }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(await saved()).toHaveLength(0);
    const calls = vi.spyOn(client, "query");
    await expect(
      store.getReport({
        query: { kind: "activeOverview", window: "all" },
      } as unknown as InsightsReportInput),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(calls).not.toHaveBeenCalled();
    await store.getReport({ query });
    await client.exec(
      `update ${headTable} set canonical_query = '{"kind":"activeOverview","window":"7d"}'::jsonb`,
    );
    await expect(store.getReport({ query })).rejects.toMatchObject({
      code: "invalid-result",
    });
    expect(await saved()).toHaveLength(1);
  });

  it.each(["\u0000", "\ud800"])(
    "preserves JSON-escaped identity %j through reservation, lease and zero-match publication",
    async (identity) => {
      const empty = JSON.stringify([
        1,
        "00000000-0000-0000-0000-000000000001",
        Array(16).fill("0"),
      ]);
      for (const query of [
        {
          kind: "bundleSummaries",
          bundleIds: [`bundle-${identity}`],
          window: "all",
        },
        { kind: "activeOverview", userId: `user-${identity}`, window: "7d" },
      ] as const) {
        const queued = await store.getReport({ query });
        expect(queued.state).toBe("queued");
        const lease = await complete(empty);
        expect(lease.job.query).toEqual(query);
        await store.withLease(lease.token, async (_transaction, current) => ({
          kind: "publish",
          summary:
            current.query.kind === "bundleSummaries"
              ? {
                  kind: "bundleSummaries",
                  summary: current.query.bundleIds.map((bundleId) => ({
                    bundleId,
                    installed: 0,
                    recovered: 0,
                  })),
                }
              : { kind: "activeOverview", summary: { activeInstallations: 0 } },
        }));
        const result = await store.getReport({ query });
        expect(result).toMatchObject({
          state: "ready",
          publication: {
            id: lease.job.id,
            sourceGeneration: empty,
            accuracy: "exact",
            summary:
              query.kind === "bundleSummaries"
                ? [{ bundleId: query.bundleIds[0], installed: 0, recovered: 0 }]
                : { activeInstallations: 0 },
          },
        });
        expect(await store.getReport({ query })).toEqual(result);
      }
    },
  );

  it("commits source capture, derived writes and checkpoint together, never replaces capture, and rejects replay or backwards progress", async () => {
    await store.getReport({ query });
    let lease = await acquire();
    await expect(
      store.withLease(lease.token, async (transaction) => {
        await sql`insert into derived_test values (1, 1)`.execute(transaction);
        throw new Error("injected worker crash");
      }),
    ).rejects.toThrow("injected worker crash");
    expect((await client.query("select * from derived_test")).rows).toEqual([]);
    expect((await saved())[0]).toMatchObject({
      source_generation: null,
      checkpoint: initial,
    });
    await store.withLease(lease.token, async (transaction) => {
      await sql`insert into derived_test values (1, 1)`.execute(transaction);
      return {
        kind: "progress",
        sourceGeneration: generation,
        checkpoint: { phase: "source", shard: 0, afterSequence: "1" },
      };
    });
    const callback = vi.fn();
    await expect(store.withLease(lease.token, callback)).rejects.toMatchObject({
      code: "INSIGHTS_LEASE_LOST",
    });
    expect(callback).not.toHaveBeenCalled();
    lease = await acquire();
    expect(lease.job.sourceGeneration).toBe(generation);
    for (const checkpoint of [
      initial,
      { phase: "source", shard: 3, afterSequence: "0" },
      { phase: "complete" },
      { phase: "installations", afterInstallKey: null },
      { phase: "source", shard: 0, afterSequence: "3" },
    ] as PostgresInsightsReportCheckpoint[]) {
      await expect(
        store.withLease(lease.token, async () => ({
          kind: "progress",
          checkpoint,
        })),
      ).rejects.toMatchObject({ code: "invalid-result" });
    }
    await expect(
      store.withLease(lease.token, async () => ({
        kind: "progress",
        sourceGeneration: generation.replace("000000000001", "000000000002"),
        checkpoint: lease.job.checkpoint,
      })),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect((await saved())[0]!.source_generation).toBe(generation);
    expect((await client.query("select * from derived_test")).rows).toEqual([
      { id: 1, value: 1 },
    ]);
  });

  it.each([
    {
      query: { kind: "bundleDetail", bundleId: "b", window: "all" },
      path: [
        { phase: "ordering", section: 0 },
        { phase: "ordering", section: 1 },
        { phase: "complete" },
      ],
    },
    {
      query: { kind: "installationOverview" },
      path: [
        { phase: "installations", afterInstallKey: null },
        { phase: "ordering", section: 0 },
        { phase: "complete" },
      ],
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      path: [
        { phase: "installations", afterInstallKey: null },
        { phase: "ordering", section: 0 },
        { phase: "ordering", section: 1 },
        { phase: "complete" },
      ],
    },
    {
      query: { kind: "bundleSummaries", bundleIds: ["b"], window: "all" },
      path: [{ phase: "complete" }],
    },
  ] satisfies {
    query: InsightsReportQuery;
    path: PostgresInsightsReportCheckpoint[];
  }[])(
    "requires every family-specific materialization phase before completion: $query.kind",
    async ({ query, path }) => {
      await store.getReport({ query });
      let lease = await sourceComplete();
      const sections = path.filter(({ phase }) => phase === "ordering").length;
      for (const [index, checkpoint] of path.entries()) {
        const previous = lease.job.checkpoint;
        for (const invalidCheckpoint of [
          ...path.slice(index + 1),
          ...(previous.phase === "ordering" && previous.section > 0
            ? [{ phase: "ordering", section: previous.section - 1 }]
            : []),
          ...(previous.phase === "ordering" ||
          query.kind === "bundleDetail" ||
          query.kind === "bundleSummaries"
            ? [{ phase: "installations", afterInstallKey: null }]
            : []),
          { phase: "source", shard: 14, afterSequence: "0" },
          { phase: "ordering", section: sections },
          { phase: "unknown" },
        ]) {
          await expect(
            store.withLease(lease.token, async (transaction) => {
              await sql`insert into derived_test values (1, 1)`.execute(
                transaction,
              );
              return {
                kind: "progress",
                checkpoint:
                  invalidCheckpoint as PostgresInsightsReportCheckpoint,
              };
            }),
          ).rejects.toMatchObject({ code: "invalid-result" });
          expect((await saved())[0]!.checkpoint).toEqual(previous);
          expect(
            (await client.query("select * from derived_test")).rows,
          ).toEqual([]);
        }
        await store.withLease(lease.token, async () => ({
          kind: "progress",
          checkpoint,
        }));
        lease = await acquire();
        expect(lease.job.checkpoint).toEqual(checkpoint);
        if (checkpoint.phase === "ordering") {
          // Several bounded ordering chunks may retain the same section.
          await store.withLease(lease.token, async () => ({
            kind: "progress",
            checkpoint,
          }));
          lease = await acquire();
          expect(lease.job.checkpoint).toEqual(checkpoint);
        }
      }
      expect(lease.job.checkpoint).toEqual({ phase: "complete" });
    },
  );

  it.each([
    {
      query: { kind: "installationOverview" },
      checkpoint: { phase: "ordering", section: 1 },
    },
    {
      query: { kind: "bundleSummaries", bundleIds: ["b"], window: "all" },
      checkpoint: { phase: "ordering", section: 0 },
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      checkpoint: { phase: "ordering", section: 2 },
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      checkpoint: { phase: "ordering", section: -1 },
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      checkpoint: { phase: "ordering", section: 0.5 },
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      checkpoint: { phase: "ordering", section: "0" },
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      checkpoint: { phase: "ordering", section: 0, after: "ignored" },
    },
    {
      query: { kind: "activeOverview", window: "7d" },
      checkpoint: { phase: "unknown" },
    },
  ] satisfies { query: InsightsReportQuery; checkpoint: unknown }[])(
    "refuses corrupt persisted phases before work or lease advancement: %j",
    async ({ query, checkpoint }) => {
      await store.getReport({ query });
      const lease = await acquire();
      await client.query(
        `update ${jobTable} set checkpoint=$1::jsonb where id=$2`,
        [JSON.stringify(checkpoint), lease.job.id],
      );
      const work = vi.fn();
      await expect(store.withLease(lease.token, work)).rejects.toMatchObject({
        code: "invalid-result",
      });
      expect(work).not.toHaveBeenCalled();
      await client.query(
        `update ${jobTable} set claimable_at=clock_timestamp()-interval '1 second' where id=$1`,
        [lease.job.id],
      );
      await expect(store.leaseNext()).rejects.toMatchObject({
        code: "invalid-result",
      });
      expect(
        (
          await client.query<{ lease_epoch: string }>(
            `select lease_epoch::text from ${jobTable} where id=$1`,
            [lease.job.id],
          )
        ).rows,
      ).toEqual([{ lease_epoch: lease.token.epoch }]);
    },
  );

  it("uses the database clock and fencing epoch to reject expired and displaced holders before invoking work", async () => {
    await store.getReport({ query });
    const first = await acquire();
    await client.exec(
      `update ${jobTable} set claimable_at = clock_timestamp() - interval '1 second'`,
    );
    const callback = vi.fn();
    await expect(store.withLease(first.token, callback)).rejects.toMatchObject({
      code: "INSIGHTS_LEASE_LOST",
    });
    expect(callback).not.toHaveBeenCalled();
    const second = await acquire();
    expect(second.token.jobId).toBe(first.token.jobId);
    expect(BigInt(second.token.epoch)).toBe(BigInt(first.token.epoch) + 1n);
    await expect(store.withLease(first.token, callback)).rejects.toMatchObject({
      code: "INSIGHTS_LEASE_LOST",
    });
    await store.withLease(second.token, async () => ({
      kind: "progress",
      sourceGeneration: generation,
      checkpoint: initial,
    }));
  });

  it("defers an uncaptured job without resetting it, then captures under a new lease once the source is ready", async () => {
    const first = await store.getReport({ query });
    const lease = await acquire();
    await store.withLease(lease.token, async () => ({ kind: "defer" }));
    expect(await store.getReport({ query })).toEqual(first);
    const next = await acquire();
    expect(next.job).toEqual(lease.job);
    expect(next.token.epoch).not.toBe(lease.token.epoch);
    await store.withLease(next.token, async () => ({
      kind: "progress",
      sourceGeneration: generation,
      checkpoint: initial,
    }));
    const captured = await acquire();
    expect(captured.job).toEqual({
      ...lease.job,
      sourceGeneration: generation,
    });
    await store.withLease(captured.token, async () => ({ kind: "defer" }));
    const resumed = await acquire();
    expect(resumed.job).toEqual(captured.job);
    await store.withLease(resumed.token, async () => ({ kind: "fail" }));
    expect(await store.getReport({ query })).toMatchObject({
      state: "failed",
      error: { jobId: lease.job.id },
    });
    expect(await store.leaseNext()).toBeNull();
    expect(await saved()).toHaveLength(1);
  });

  it.each([
    { bundleIds: [], after: "0", allowed: true },
    { bundleIds: ["bundle"], after: "0", allowed: false },
    { bundleIds: [], after: "1", allowed: false },
  ])(
    "permits immediate completion only for an initially empty batch: %j",
    async ({ bundleIds, after, allowed }) => {
      const query = {
        kind: "bundleSummaries",
        bundleIds,
        window: "all",
      } as const;
      await store.getReport({ query });
      let lease = await acquire();
      if (after !== "0") {
        await store.withLease(lease.token, async () => ({
          kind: "progress",
          sourceGeneration: generation,
          checkpoint: { phase: "source", shard: 0, afterSequence: after },
        }));
        lease = await acquire();
      }
      const finish = (sourceGeneration: string) =>
        store.withLease(lease.token, async () => ({
          kind: "progress",
          sourceGeneration,
          checkpoint: { phase: "complete" },
        }));
      if (!allowed) {
        await expect(finish(generation)).rejects.toMatchObject({
          code: "invalid-result",
        });
        expect((await saved())[0]!.checkpoint.phase).toBe("source");
        return;
      }
      await expect(finish("uncaptured")).rejects.toMatchObject({
        code: "invalid-result",
      });
      await finish(generation);
      const captured = await acquire();
      expect(captured.job).toMatchObject({
        sourceGeneration: generation,
        checkpoint: { phase: "complete" },
      });
      await store.withLease(captured.token, async () => ({
        kind: "publish",
        summary: { kind: "bundleSummaries", summary: [] },
      }));
      expect(await store.getReport({ query })).toMatchObject({
        state: "ready",
        publication: { sourceGeneration: generation, summary: [] },
      });
    },
  );

  it("rolls back callback writes when the lease expires during work", async () => {
    await store.getReport({ query });
    const lease = await acquire();
    await expect(
      store.withLease(lease.token, async (transaction) => {
        await sql`insert into derived_test values (1, 1)`.execute(transaction);
        await sql`update ${sql.table(jobTable)} set claimable_at = clock_timestamp() - interval '1 second' where id = ${lease.job.id}::uuid`.execute(
          transaction,
        );
        return {
          kind: "progress",
          sourceGeneration: generation,
          checkpoint: initial,
        };
      }),
    ).rejects.toMatchObject({ code: "INSIGHTS_LEASE_LOST" });
    expect((await client.query("select * from derived_test")).rows).toEqual([]);
    expect((await saved())[0]).toMatchObject({
      status: "preparing",
      source_generation: null,
      checkpoint: initial,
    });
  });

  it("publishes one immutable summary and retains it while a newer job fails without automatic poison retries", async () => {
    await store.getReport({ query });
    const lease = await complete();
    const wrong = {
      kind: "activeOverview",
      summary: { activeInstallations: 8 },
    } as const;
    await expect(
      store.withLease(lease.token, async () => ({
        kind: "publish",
        summary: wrong,
      })),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await store.withLease(lease.token, async () => ({
      kind: "publish",
      summary: {
        kind: "installationOverview",
        summary: { trackedInstallations: 8 },
      },
    }));
    const result = await store.getReport({ query });
    expect(result).toMatchObject({
      state: "ready",
      publication: {
        id: lease.job.id,
        asOfMs: lease.job.asOfMs,
        accuracy: "exact",
        sourceGeneration: generation,
        kind: "installationOverview",
        summary: { trackedInstallations: 8 },
      },
    });
    if (result.state !== "ready") throw new Error("Publication missing");
    await expect(
      store.withLease(lease.token, async () => ({ kind: "fail" })),
    ).rejects.toMatchObject({ code: "INSIGHTS_LEASE_LOST" });
    const newer = await store.getReport({
      query,
      minAsOfMs: result.publication.asOfMs + 1,
    });
    expect(newer).toMatchObject({
      state: "queued",
      previous: result.publication,
    });
    const failed = await acquire();
    await store.withLease(failed.token, async () => ({ kind: "fail" }));
    for (let i = 0; i < 3; i++)
      expect(
        await store.getReport({
          query,
          minAsOfMs: result.publication.asOfMs + 1,
        }),
      ).toEqual({
        state: "failed",
        error: { code: "preparation-failed", jobId: failed.job.id },
        previous: result.publication,
      });
    expect(await store.getReport({ query })).toEqual(result);
    expect(await store.leaseNext()).toBeNull();
    expect(await saved()).toHaveLength(2);
  });

  it("looks up immutable publications independently of the current head and distinguishes missing from pending", async () => {
    expect(
      await readPostgresInsightsReportPublication(
        db,
        "00000000-0000-0000-0000-000000000099",
      ),
    ).toBeNull();
    const queued = await store.getReport({ query });
    if (queued.state !== "queued") throw new Error("Queued fixture missing");
    await expect(
      readPostgresInsightsReportPublication(db, queued.jobId),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    const publish = async (trackedInstallations: number) => {
      const lease = await complete();
      await expect(
        readPostgresInsightsReportPublication(db, lease.job.id),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      await store.withLease(lease.token, async () => ({
        kind: "publish",
        summary: {
          kind: "installationOverview",
          summary: { trackedInstallations },
        },
      }));
      const result = await readPostgresInsightsReportPublication(
        db,
        lease.job.id,
      );
      expect(result).toMatchObject({
        job: lease.job,
        publication: {
          id: lease.job.id,
          sourceGeneration: generation,
          summary: { trackedInstallations },
        },
      });
      return result!;
    };
    const first = await publish(8);
    await store.getReport({ query, minAsOfMs: first.publication.asOfMs + 1 });
    const second = await publish(9);
    expect(second.publication.id).not.toBe(first.publication.id);
    expect(await store.getReport({ query })).toEqual({
      state: "ready",
      publication: second.publication,
    });
    expect(
      await readPostgresInsightsReportPublication(db, first.publication.id),
    ).toEqual(first);
    const calls = vi.spyOn(client, "query");
    await expect(
      readPostgresInsightsReportPublication(db, "not-a-publication"),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(calls).not.toHaveBeenCalled();
  });

  it("rejects out-of-order or oversized bundle summaries and does not promote a publication after lease expiry", async () => {
    await store.getReport({
      query: { kind: "bundleSummaries", bundleIds: ["b", "a"], window: "all" },
    });
    const lease = await complete();
    for (const summary of [
      Array<{ bundleId: string; installed: number; recovered: number }>(2),
      [
        { bundleId: "b", installed: 1, recovered: 0 },
        { bundleId: "a", installed: 0, recovered: 0 },
      ],
      [
        { bundleId: "a", installed: Number.MAX_SAFE_INTEGER + 1, recovered: 0 },
        { bundleId: "b", installed: 0, recovered: 0 },
      ],
    ])
      await expect(
        store.withLease(lease.token, async () => ({
          kind: "publish",
          summary: { kind: "bundleSummaries", summary },
        })),
      ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      store.withLease(lease.token, async (transaction) => {
        await sql`insert into derived_test values (1, 1)`.execute(transaction);
        await sql`update ${sql.table(jobTable)} set claimable_at = clock_timestamp() - interval '1 second' where id = ${lease.job.id}::uuid`.execute(
          transaction,
        );
        return {
          kind: "publish",
          summary: {
            kind: "bundleSummaries",
            summary: [
              { bundleId: "a", installed: 1, recovered: 0 },
              { bundleId: "b", installed: 0, recovered: 0 },
            ],
          },
        };
      }),
    ).rejects.toMatchObject({ code: "INSIGHTS_LEASE_LOST" });
    expect((await client.query("select * from derived_test")).rows).toEqual([]);
    expect(
      (await client.query(`select publication_job_id from ${headTable}`)).rows,
    ).toEqual([{ publication_job_id: null }]);
    expect((await saved())[0]!.status).toBe("preparing");
  });

  it("bounds the actual claim plan with 50,001 future leases and refuses a missing claim index", async () => {
    await client.exec(`create temporary table seeded_jobs as
      select ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid id,
        encode(sha256(convert_to('[2,' || to_json('[1,"activeOverview","7d","' || n::text || '"]')::text || ']', 'UTF8')), 'hex') query_key,
        jsonb_build_object('kind','activeOverview','window','7d','userId',n::text) canonical_query
      from generate_series(0,50000)n;
      insert into ${headTable}(query_key,canonical_query) select query_key,canonical_query from seeded_jobs;
      insert into ${jobTable}(id,query_key,as_of_ms,status,checkpoint,lease_epoch,claimable_at)
        select id,query_key,0,'preparing','{"phase":"source","shard":0,"afterSequence":"0"}'::jsonb,1,
          clock_timestamp()+interval '1 day' from seeded_jobs;
      update ${headTable} h set active_job_id=s.id from seeded_jobs s where s.query_key=h.query_key;
      analyze ${jobTable}; analyze ${headTable};`);
    const queries = vi.spyOn(client, "query");
    expect(await store.leaseNext()).toBeNull();
    const call = queries.mock.calls.find(([query]) =>
      /with candidate as materialized/.test(query),
    )!;
    expect(call).toBeDefined();
    type Plan = {
      "Node Type": string;
      "Actual Rows": number;
      "Actual Loops": number;
      "Rows Removed by Filter"?: number;
      "Index Cond"?: string;
      "Index Name"?: string;
      Plans?: Plan[];
    };
    const explain = async () => {
      const result = await client.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${call[0]}`,
        call[1],
      );
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        node.Plans?.forEach(visit);
      };
      visit(result.rows[0]!["QUERY PLAN"][0]!.Plan);
      expect(
        nodes.find(
          (node) =>
            node["Index Name"] ===
            "private_hot_updater_insights_report_claim_idx",
        )?.["Index Cond"],
      ).toContain("statement_timestamp()");
      for (const node of nodes) {
        expect(node["Node Type"]).not.toMatch(/Seq Scan|Sort/);
        expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(
          1,
        );
        expect(node["Rows Removed by Filter"] ?? 0).toBe(0);
      }
    };
    await explain();
    await client.exec(
      `update ${jobTable} set claimable_at=clock_timestamp()-interval '1 second' where id='10000000-0000-0000-0000-000000000001'`,
    );
    await explain();
    await client.exec(
      "drop index private_hot_updater_insights_report_claim_idx",
    );
    queries.mockClear();
    await expect(store.leaseNext()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(
      queries.mock.calls.some(([query]) =>
        /with candidate as materialized/.test(query),
      ),
    ).toBe(false);
  });
});
