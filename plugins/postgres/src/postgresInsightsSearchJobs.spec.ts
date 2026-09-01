import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migratePostgresInsightsSource } from "./db";
import {
  createPostgresInsightsJobs,
  isPostgresInsightsContainsJob,
  readPostgresInsightsReportPublication,
  readPostgresInsightsSearchPublication,
  type PostgresInsightsJobUpdate,
  type PostgresInsightsSearchResult,
} from "./postgresInsightsJobs";
import { createPostgresInsightsSourceTools } from "./postgresInsightsSource";

const jobsTable = "private_hot_updater_insights_report_jobs";
const headsTable = "private_hot_updater_insights_report_heads";
const queuedId = (result: PostgresInsightsSearchResult) => {
  if (result.state !== "queued" && result.state !== "preparing")
    throw new Error("Expected a pending search.");
  return result.jobId;
};

describe("private PostgreSQL historical contains jobs", () => {
  let client: PGlite;
  let db: Kysely<object>;
  let store: ReturnType<typeof createPostgresInsightsJobs>;
  let generation: string;
  let requests: string[];
  let returnedRows: number;
  beforeEach(async () => {
    client = new PGlite();
    requests = [];
    returnedRows = 0;
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    db = new Kysely<object>({
      dialect: new PGliteDialect(client),
      log: (event) => {
        requests.push(event.query.sql);
      },
      plugins: [
        {
          transformQuery: ({ node }) => node,
          async transformResult({ result }) {
            returnedRows += result.rows.length;
            return result;
          },
        },
      ],
    });
    await migratePostgresInsightsSource(db);
    const source = createPostgresInsightsSourceTools(db);
    await source.backfillStep(1);
    generation = await source.capture();
    await client.exec(
      await readFile("plugins/postgres/sql/insights-reports-v1.sql", "utf8"),
    );
    await client.exec("create table derived_test(id integer primary key)");
    requests = [];
    returnedRows = 0;
    store = createPostgresInsightsJobs(db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });
  const saved = async (id: string) =>
    (
      await client.query<{
        id: string;
        base_job_id: string | null;
        as_of_ms: number | null;
        source_generation: string | null;
        checkpoint: unknown;
        status: string;
      }>(`select * from ${jobsTable} where id=$1::uuid`, [id])
    ).rows[0]!;
  const acquire = async (id: string) => {
    // Select the scenario's worker without changing its checkpoint or lease epoch.
    await client.query(
      `update ${jobsTable} set claimable_at='-infinity'::timestamptz where id=$1::uuid`,
      [id],
    );
    const lease = await store.leaseNext();
    if (lease === null || lease.job.id !== id)
      throw new Error("Expected requested job lease.");
    return lease;
  };
  const update = async (id: string, next: PostgresInsightsJobUpdate) => {
    const lease = await acquire(id);
    await store.withLease(lease.token, async () => next);
  };
  const publishBase = async (id: string) => {
    for (let shard = 1; shard < 16; shard++)
      await update(id, {
        kind: "progress",
        checkpoint: { phase: "source", shard, afterSequence: "0" },
      });
    await update(id, {
      kind: "progress",
      checkpoint: { phase: "installations", afterInstallKey: null },
    });
    await update(id, {
      kind: "progress",
      checkpoint: { phase: "ordering", section: 0 },
    });
    await update(id, { kind: "progress", checkpoint: { phase: "complete" } });
    await update(id, {
      kind: "publish",
      summary: {
        kind: "installationOverview",
        summary: { trackedInstallations: 0 },
      },
    });
  };
  const publishSearch = async (id: string, total: number) => {
    if ((await saved(id)).as_of_ms === null)
      await update(id, { kind: "bindIdentity" });
    await update(id, { kind: "progress", checkpoint: { phase: "ordering" } });
    await update(id, { kind: "progress", checkpoint: { phase: "complete" } });
    await update(id, { kind: "publishSearch", total });
  };

  it("coalesces normalized searches and pins one shared base without raw reads or an invented length limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, minAsOfMs) =>
        store.getSearch({
          kind: "contains",
          query: minAsOfMs % 2 ? "Former-USER" : "former-user",
          minAsOfMs,
        }),
      ),
    );
    expect(new Set(results.map(queuedId)).size).toBe(1);
    const id = queuedId(results[0]!);
    const first = await saved(id);
    expect(first).toMatchObject({
      as_of_ms: null,
      source_generation: generation,
      checkpoint: { phase: "awaitIdentity" },
    });
    expect(
      (await client.query(`select id from ${jobsTable}`)).rows,
    ).toHaveLength(2);

    const long = "İ".repeat(500) + "\u0000";
    const other = queuedId(
      await store.getSearch({ kind: "contains", query: long }),
    );
    expect((await saved(other)).base_job_id).toBe(first.base_job_id);
    const rows = (
      await client.query<{ canonical_query: { normalizedQuery?: string } }>(
        `select canonical_query from ${headsTable}`,
      )
    ).rows;
    expect(
      rows.some(
        ({ canonical_query }) =>
          canonical_query.normalizedQuery === long.toLowerCase(),
      ),
    ).toBe(true);
    expect(
      (
        await client.query(
          `select id from ${jobsTable} where base_job_id is null`,
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      queuedId(
        await store.getSearch({ kind: "contains", query: " former-user " }),
      ),
    ).not.toBe(id);
    const composed = queuedId(
      await store.getSearch({ kind: "contains", query: "É" }),
    );
    expect(
      queuedId(await store.getSearch({ kind: "contains", query: "E\u0301" })),
    ).not.toBe(composed);
  });

  it("bounds reservation and polling to metadata and never re-reserves the base while a search is active", async () => {
    const id = queuedId(
      await store.getSearch({
        kind: "contains",
        query: "budget",
        minAsOfMs: 0,
      }),
    );
    expect(requests).toHaveLength(15);
    expect(returnedRows).toBe(22);
    requests = [];
    returnedRows = 0;
    for (let i = 0; i < 10; i++)
      expect(
        await store.getSearch({
          kind: "contains",
          query: "BUDGET",
          minAsOfMs: i,
        }),
      ).toMatchObject({ state: "queued", jobId: id });
    expect(requests).toHaveLength(80);
    expect(returnedRows).toBe(50);
    expect(
      requests.filter((query) => /^insert into/i.test(query)),
    ).toHaveLength(10);
    expect(
      requests.some((query) =>
        /insert into "private_hot_updater_insights_report_jobs"/i.test(query),
      ),
    ).toBe(false);
    // The only data relation read per poll is its one existing search job.
    expect(
      requests.filter((query) => /select \*, lease_epoch::text/.test(query)),
    ).toHaveLength(10);
    const lease = await acquire(id);
    requests = [];
    returnedRows = 0;
    await store.withLease(lease.token, async () => ({ kind: "bindIdentity" }));
    expect(requests).toHaveLength(7);
    expect(returnedRows).toBe(5);
  });

  it("binds once from the completed base and rejects skipped phases, rebinding, bad totals and rollback leaks", async () => {
    const id = queuedId(
      await store.getSearch({ kind: "contains", query: "OLD" }),
    );
    const base = (await saved(id)).base_job_id!;
    await update(id, { kind: "bindIdentity" });
    expect(await saved(id)).toMatchObject({
      as_of_ms: null,
      checkpoint: { phase: "awaitIdentity" },
      status: "queued",
    });
    const premature = await acquire(id);
    await expect(
      store.withLease(premature.token, async (tx) => {
        await sql`insert into derived_test values(1)`.execute(tx);
        return {
          kind: "progress",
          checkpoint: { phase: "aliases", afterAliasKey: null },
        };
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect((await client.query("select * from derived_test")).rows).toEqual([]);
    await publishBase(base);
    await update(id, { kind: "bindIdentity" });
    expect(await saved(id)).toMatchObject({
      as_of_ms: (await saved(base)).as_of_ms,
      source_generation: generation,
      base_job_id: base,
      checkpoint: { phase: "aliases", afterAliasKey: null },
    });
    let lease = await acquire(id);
    expect(isPostgresInsightsContainsJob(lease.job)).toBe(true);
    for (const next of [
      { kind: "bindIdentity" },
      { kind: "progress", checkpoint: { phase: "complete" } },
      { kind: "publishSearch", total: 0 },
    ] as PostgresInsightsJobUpdate[])
      await expect(
        store.withLease(lease.token, async () => next),
      ).rejects.toMatchObject({ code: "invalid-result" });
    await store.withLease(lease.token, async () => ({
      kind: "progress",
      checkpoint: { phase: "aliases", afterAliasKey: "b".repeat(64) },
    }));
    lease = await acquire(id);
    await expect(
      store.withLease(lease.token, async () => ({
        kind: "progress",
        checkpoint: { phase: "aliases", afterAliasKey: "a".repeat(64) },
      })),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await store.withLease(lease.token, async () => ({
      kind: "progress",
      checkpoint: { phase: "ordering" },
    }));
    await update(id, { kind: "progress", checkpoint: { phase: "complete" } });
    lease = await acquire(id);
    for (const total of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      await expect(
        store.withLease(lease.token, async () => ({
          kind: "publishSearch",
          total,
        })),
      ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      store.withLease(lease.token, async () => ({
        kind: "publish",
        summary: {
          kind: "installationOverview",
          summary: { trackedInstallations: 1 },
        },
      })),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await store.withLease(lease.token, async () => ({
      kind: "publishSearch",
      total: 7,
    }));
    expect(
      await store.getSearch({ kind: "contains", query: "old" }),
    ).toMatchObject({
      state: "ready",
      publication: {
        id,
        total: 7,
        asOfMs: (await saved(base)).as_of_ms,
        sourceGeneration: generation,
        accuracy: "exact",
      },
    });
  });

  it("does not wait forever on a coalesced older base or misstate its time to satisfy a newer selector", async () => {
    const baseResult = await store.getReport({
      query: { kind: "installationOverview" },
    });
    if (baseResult.state !== "queued") throw new Error("Expected base.");
    const base = baseResult.jobId;
    const oldTime = Date.now() - 100_000;
    await client.query(
      `update ${jobsTable} set as_of_ms=$2 where id=$1::uuid`,
      [base, oldTime],
    );
    const input = {
      kind: "contains" as const,
      query: "former",
      minAsOfMs: oldTime + 1000,
    };
    const id = queuedId(await store.getSearch(input));
    expect((await saved(id)).base_job_id).toBe(base);
    await publishBase(base);
    await publishSearch(id, 2);
    const old = await readPostgresInsightsSearchPublication(
      db,
      id,
      "contains",
      "former",
    );
    expect(old?.publication).toMatchObject({ total: 2, asOfMs: oldTime });
    const next = await store.getSearch(input);
    const nextId = queuedId(next);
    expect(next).toMatchObject({ previous: old!.publication });
    expect(nextId).not.toBe(id);
    const nextBase = (await saved(nextId)).base_job_id!;
    expect(nextBase).not.toBe(base);
    await publishBase(nextBase);
    await publishSearch(nextId, 3);
    expect(await store.getSearch(input)).toMatchObject({
      state: "ready",
      publication: { id: nextId, total: 3 },
    });
    expect(
      await readPostgresInsightsSearchPublication(db, id, "contains", "former"),
    ).toEqual(old);
    // Neither current head references the old base now. Its old search still pins it.
    await expect(
      client.query(`delete from ${jobsTable} where id=$1::uuid`, [base]),
    ).rejects.toMatchObject({ code: "23503" });
    await client.query(`delete from ${jobsTable} where id=$1::uuid`, [id]);
    await client.query(`delete from ${jobsTable} where id=$1::uuid`, [base]);
    expect(
      await readPostgresInsightsSearchPublication(db, id, "contains", "former"),
    ).toBeNull();
  });

  it("makes a failed base visible without rebinding or creating retries", async () => {
    const id = queuedId(
      await store.getSearch({ kind: "contains", query: "poison" }),
    );
    const base = (await saved(id)).base_job_id!;
    await update(base, { kind: "fail" });
    for (let i = 0; i < 3; i++)
      expect(
        await store.getSearch({
          kind: "contains",
          query: "POISON",
          minAsOfMs: i,
        }),
      ).toEqual({
        state: "failed",
        error: { code: "preparation-failed", jobId: id },
        sourceGeneration: generation,
        previous: null,
      });
    const other = await store.getSearch({ kind: "contains", query: "another" });
    expect(other).toMatchObject({ state: "failed", previous: null });
    if (other.state !== "failed") throw new Error("Expected failed dependent.");
    expect((await saved(other.error.jobId)).base_job_id).toBe(base);
    expect(
      (await client.query(`select id from ${jobsTable}`)).rows,
    ).toHaveLength(3);
    expect(await store.leaseNext()).toBeNull();
  });

  it("keeps pinned lookups read-only and rejects wrong scopes or malformed requests before storage", async () => {
    const id = queuedId(
      await store.getSearch({ kind: "contains", query: "pinned" }),
    );
    const calls = vi.spyOn(client, "query");
    await expect(
      readPostgresInsightsSearchPublication(db, id, "contains", "pinned"),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(
      calls.mock.calls.some(([query]) =>
        /^\s*(insert|update|delete)/i.test(query),
      ),
    ).toBe(false);
    calls.mockClear();
    for (const input of [
      { query: "" },
      { query: 1 },
      { query: "a", minAsOfMs: -1 },
      { query: "a", limit: 1 },
      null,
    ])
      await expect(store.getSearch(input as never)).rejects.toMatchObject({
        code: "invalid-query",
      });
    await expect(
      readPostgresInsightsSearchPublication(db, "bad", "contains", "pinned"),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      readPostgresInsightsSearchPublication(db, id, "contains", "UPPER"),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(calls).not.toHaveBeenCalled();
    await publishBase((await saved(id)).base_job_id!);
    await publishSearch(id, 0);
    await expect(
      readPostgresInsightsSearchPublication(db, id, "contains", "another"),
    ).resolves.toBeNull();
    await expect(
      readPostgresInsightsReportPublication(db, id),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      readPostgresInsightsSearchPublication(
        db,
        (await saved(id)).base_job_id!,
        "contains",
        "pinned",
      ),
    ).resolves.toBeNull();
  });

  it("rejects future freshness before reserving either a search or a base", async () => {
    await expect(
      store.getSearch({
        kind: "contains",
        query: "future",
        minAsOfMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect((await client.query(`select id from ${jobsTable}`)).rows).toEqual(
      [],
    );
    expect(
      (await client.query(`select query_key from ${headsTable}`)).rows,
    ).toEqual([]);
    expect(requests.some((query) => /^\s*insert/i.test(query))).toBe(false);
  });

  it("rolls back derived search progress when its lease expires", async () => {
    const id = queuedId(
      await store.getSearch({ kind: "contains", query: "lease" }),
    );
    await publishBase((await saved(id)).base_job_id!);
    await update(id, { kind: "bindIdentity" });
    const lease = await acquire(id);
    await expect(
      store.withLease(lease.token, async (tx) => {
        await sql`insert into derived_test values(1)`.execute(tx);
        await sql`update ${sql.table(jobsTable)} set claimable_at=clock_timestamp()-interval '1 second' where id=${id}::uuid`.execute(
          tx,
        );
        return {
          kind: "progress",
          checkpoint: { phase: "aliases", afterAliasKey: "a".repeat(64) },
        };
      }),
    ).rejects.toMatchObject({ code: "INSIGHTS_LEASE_LOST" });
    expect((await client.query("select * from derived_test")).rows).toEqual([]);
    expect((await saved(id)).checkpoint).toEqual({
      phase: "aliases",
      afterAliasKey: null,
    });
  });

  it.each([
    "index",
    "foreign key",
    "old cutoff nullability",
    "nullable source generation",
  ])(
    "rejects an incomplete current layout (%s) before reservation",
    async (part) => {
      if (part === "index")
        await client.exec(
          "drop index private_hot_updater_insights_report_base_idx",
        );
      else if (part === "foreign key")
        await client.exec(
          `alter table ${jobsTable} drop constraint ${jobsTable}_base_job_id_fkey`,
        );
      else if (part === "old cutoff nullability")
        await client.exec(
          `alter table ${jobsTable} alter column as_of_ms set not null`,
        );
      else
        await client.exec(
          `alter table ${jobsTable} alter column source_generation drop not null`,
        );
      const calls = vi.spyOn(client, "query");
      await expect(
        store.getSearch({ kind: "contains", query: "never" }),
      ).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
      expect(
        calls.mock.calls.some(([query]) => /^\s*insert/i.test(query)),
      ).toBe(false);
    },
  );

  it("rejects prior storage-revision jobs instead of resuming aliasless checkpoints", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const oldKey = createHash("sha256")
      .update(JSON.stringify([1, JSON.stringify([1, "installationOverview"])]))
      .digest("hex");
    await client.query(
      `insert into ${headsTable}(query_key,canonical_query,active_job_id) values($1,'{"kind":"installationOverview"}'::json,null)`,
      [oldKey],
    );
    await client.query(
      `insert into ${jobsTable}(id,query_key,as_of_ms,status,source_generation,checkpoint) values($1::uuid,$2,0,'queued',$3,'{"phase":"source","shard":0,"afterSequence":"0"}'::jsonb)`,
      [id, oldKey, generation],
    );
    await client.query(
      `update ${headsTable} set active_job_id=$2::uuid where query_key=$1`,
      [oldKey, id],
    );
    await expect(store.leaseNext()).rejects.toMatchObject({
      code: "invalid-result",
    });
    expect(await saved(id)).toMatchObject({
      status: "queued",
      checkpoint: { phase: "source", shard: 0, afterSequence: "0" },
    });
    await expect(
      readPostgresInsightsReportPublication(db, id),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });
});
