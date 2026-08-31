import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleEventRow,
  InsightsReportQuery,
  InsightsReportSection,
} from "@hot-updater/plugin-core";
import { createInsightsReportPageCursor } from "@hot-updater/plugin-core/internal";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectActiveInstallationOverview } from "../../../packages/server/src/insights/bounded/activeOverview";
import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  migratePostgresInsightsLive,
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { postgres } from "./postgres";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import { createPostgresInsightsReportPages } from "./postgresInsightsReportPages";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import { createPostgresInsightsSourceTools } from "./postgresInsightsSource";
import type { Database } from "./types";

const day = 86_400_000;
const cutoff = Date.UTC(2026, 0, 11, 12, 34, 56);
const today = Math.floor(cutoff / day) * day;
const bundleA = createBundleEventRowFixture("1", 1).to_bundle_id;
const bundleB = createBundleEventRowFixture("2", 1).to_bundle_id;
const bundleC = createBundleEventRowFixture("3", 1).to_bundle_id;
const event = (
  id: number,
  time: number,
  overrides: Partial<BundleEventRow> = {},
) =>
  ({
    ...createBundleEventRowFixture(String(id), time),
    to_bundle_id: bundleA,
    ...overrides,
  }) as BundleEventRow;

describe("immutable PostgreSQL report section pages", () => {
  let client: PGlite;
  let db: Kysely<Database>;
  let plugin: ReturnType<typeof postgres>;
  let jobs: ReturnType<typeof createPostgresInsightsJobs<Database>>;
  let worker: ReturnType<typeof createPostgresInsightsReportWorker<Database>>;
  let pages: ReturnType<typeof createPostgresInsightsReportPages<Database>>;
  let statements: string[];
  let returnedRows: number;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    statements = [];
    returnedRows = 0;
    db = new Kysely<Database>({
      dialect: new PGliteDialect(client),
      log: (event) => {
        statements.push(event.query.sql);
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
    plugin = postgres({ dialect: new PGliteDialect(client) });
    await migratePostgresInsightsSource(db);
    await migratePostgresInsightsReports(db);
    await createPostgresInsightsSourceTools(db).backfillStep(1);
    await migratePostgresInsightsLive(db);
    await createPostgresInsightsLiveTools(db).backfillStep(1);
    jobs = createPostgresInsightsJobs(db);
    worker = createPostgresInsightsReportWorker(db);
    pages = createPostgresInsightsReportPages(db);
  });
  afterEach(async () => {
    await plugin.dispose?.();
    await db.destroy();
    await client.close();
  });
  const reserve = async (query: InsightsReportQuery, asOfMs = cutoff) => {
    const result = await jobs.getReport({ query, minAsOfMs: asOfMs });
    if (result.state !== "queued") throw new Error("Expected queued job.");
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms = ${asOfMs} where id = ${result.jobId}::uuid`.execute(
      db,
    );
    return result.jobId;
  };
  const finish = async (query: InsightsReportQuery, asOfMs = cutoff) => {
    for (let i = 0; i < 1000; i++) {
      const result = await worker.runStep({ maxItems: 256, maxRequests: 128 });
      if (result.state === "published") {
        const report = await jobs.getReport({ query, minAsOfMs: asOfMs });
        if (report.state !== "ready") throw new Error("Expected ready job.");
        return report.publication;
      }
      expect(result.state).toBe("progress");
    }
    throw new Error("Report did not complete within bounded steps.");
  };
  const read = async (
    publicationId: string,
    section: InsightsReportSection,
    limit = 100,
    cursor?: string,
  ) => {
    statements = [];
    returnedRows = 0;
    const result = await pages.pageReport({
      ...section,
      publicationId,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(
      statements.some((query) => /\bbundle_events\b|\boffset\b/i.test(query)),
    ).toBe(false);
    // This test dialect ignores accessMode; the real PostgreSQL integration
    // scenario separately verifies read-only transaction settings.
    expect(statements[0]).toMatch(/repeatable read/i);
    expect(statements.length).toBeLessThanOrEqual(13);
    expect(returnedRows).toBeLessThanOrEqual(limit * 2 + 11);
    if (result.state !== "ready") throw new Error("Expected page.");
    return result;
  };

  it("pages long Unicode cohorts without losing ties and keeps metric-specific all-time UTC series", async () => {
    const prefix = "가".repeat(1600);
    const labels = Array.from(
      { length: 129 },
      (_, i) =>
        `${prefix}${i % 2 ? "😀" : "\ue000"}${String(i).padStart(3, "0")}`,
    );
    for (const [i, cohort] of [...labels].reverse().entries())
      await plugin.models.insights.append(
        event(i + 1, today - 2 * day, { install_id: `install-${i}`, cohort }),
      );
    await plugin.models.insights.append(
      event(200, today - 7 * day, {
        type: "RECOVERED",
        from_bundle_id: bundleA,
        to_bundle_id: bundleB,
      }),
    );
    const query = {
      kind: "bundleDetail",
      bundleId: bundleA,
      window: "all",
    } as const;
    const id = await reserve(query);
    const publication = await finish(query);
    expect(publication.summary).toEqual({ installed: 129, recovered: 1 });
    const section = {
      section: "movementCohorts",
      metric: "installed",
    } as const;
    const first = await read(id, section, 1);
    const second = await read(id, section, 100, first.nextCursor!);
    const third = await read(id, section, 28, second.nextCursor!);
    expect([...first.rows, ...second.rows, ...third.rows]).toEqual(
      labels.sort().map((cohort) => ({ cohort, value: 1 })),
    );
    expect(third.nextCursor).toBeNull();
    const installed = await read(id, {
      section: "movementSeries",
      metric: "installed",
    });
    expect(installed.rows).toEqual([
      { bucketStartMs: today - 2 * day, value: 129 },
      { bucketStartMs: today - day, value: 0 },
      { bucketStartMs: today, value: 0 },
    ]);
    const recovered = await read(id, {
      section: "movementSeries",
      metric: "recovered",
    });
    expect(recovered.rows).toHaveLength(8);
    expect(recovered.rows[0]).toEqual({
      bucketStartMs: today - 7 * day,
      value: 1,
    });
    expect(recovered.rows.at(-1)).toEqual({ bucketStartMs: today, value: 0 });
  });

  it("matches active semantics across bundle boundaries, changed page sizes, identity changes and exact filters", async () => {
    const start = cutoff - 7 * day;
    const rows = Array.from({ length: 7 }, (_, i) =>
      event(i + 1, start + i * day, {
        install_id: "moving",
        user_id: i === 6 ? "selected" : "old-name",
        to_bundle_id: i === 6 ? bundleB : bundleA,
      }),
    );
    rows.push(
      event(8, cutoff - 1, {
        install_id: "other",
        user_id: "selected",
        to_bundle_id: bundleB,
      }),
    );
    for (let i = 0; i < 3; i++)
      rows.push(
        event(10 + i, cutoff - 1, {
          install_id: `third-${i}`,
          user_id: "selected",
          to_bundle_id: bundleC,
          type: "UNCHANGED",
          from_bundle_id: null,
          update_strategy: null,
        }),
      );
    rows.push(
      event(20, cutoff - 2, { install_id: "excluded", user_id: "selected" }),
      event(21, cutoff - 1, { install_id: "excluded", user_id: "other" }),
    );
    for (const row of rows.reverse()) await plugin.models.insights.append(row);
    const query = {
      kind: "activeOverview",
      window: "7d",
      userId: "selected",
    } as const;
    const id = await reserve(query);
    await finish(query);
    const expected = collectActiveInstallationOverview({
      rows,
      asOfMs: cutoff,
      window: "7d",
      userId: "selected",
    });
    expect((await read(id, { section: "bundleDistribution" })).rows).toEqual(
      expected.bundles,
    );
    expect((await read(id, { section: "activeSeries" })).rows).toEqual(
      expected.series,
    );
    const first = await read(id, { section: "activeBundleSeries" }, 5);
    const second = await read(
      id,
      { section: "activeBundleSeries" },
      17,
      first.nextCursor!,
    );
    expect([...first.rows, ...second.rows]).toEqual(
      expected.bundleSeries.flatMap(({ bundleId, series }) =>
        series.map((row) => ({ bundleId, ...row })),
      ),
    );
    expect(second.nextCursor).toBeNull();
    expect(expected.bundleSeries[0]!.bundleId).toBe(bundleA);
    expect(expected.bundles[0]!.bundleId).toBe(bundleC);
    const filtered = await read(
      id,
      { section: "activeBundleSeries", bundleId: bundleA },
      2,
    );
    const filteredNext = await read(
      id,
      { section: "activeBundleSeries", bundleId: bundleA },
      5,
      filtered.nextCursor!,
    );
    expect([...filtered.rows, ...filteredNext.rows]).toEqual(
      expected.bundleSeries[0]!.series.map((row) => ({
        bundleId: bundleA,
        ...row,
      })),
    );
    for (const bundleId of ["missing", "nul\0", "surrogate\ud800"])
      expect(
        await read(id, { section: "activeBundleSeries", bundleId }),
      ).toMatchObject({ rows: [], nextCursor: null });
    await expect(
      pages.pageReport({
        publicationId: id,
        section: "activeBundleSeries",
        bundleId: bundleB,
        limit: 5,
        cursor: filtered.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("retains old publication pages during and after refresh, and distinguishes missing from unpublished", async () => {
    await plugin.models.insights.append(event(1, cutoff - 10));
    const query = { kind: "installationOverview" } as const;
    const id = await reserve(query);
    await expect(
      pages.pageReport({
        publicationId: id,
        section: "bundleDistribution",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    await finish(query);
    const old = await read(id, { section: "bundleDistribution" });
    await plugin.models.insights.append(
      event(2, cutoff + 1, { to_bundle_id: bundleB }),
    );
    const nextId = await reserve(query, cutoff + 2);
    expect(await read(id, { section: "bundleDistribution" })).toEqual(old);
    await finish(query, cutoff + 2);
    expect(await read(id, { section: "bundleDistribution" })).toEqual(old);
    expect(
      (await read(nextId, { section: "bundleDistribution" })).rows,
    ).toHaveLength(2);
    expect(
      await pages.pageReport({
        publicationId: "00000000-0000-0000-0000-000000000099",
        section: "bundleDistribution",
        limit: 1,
      }),
    ).toMatchObject({ state: "expired" });
    statements = [];
    await expect(
      pages.pageReport({
        publicationId: "not-uuid",
        section: "bundleDistribution",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(statements).toEqual([]);
    await expect(
      pages.pageReport({
        publicationId: id,
        section: "activeSeries",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("provides one current zero bucket for an empty all-time metric and indexed deep series pages", async () => {
    await plugin.models.insights.append(event(1, 0));
    const query = {
      kind: "bundleDetail",
      bundleId: bundleA,
      window: "all",
    } as const;
    const id = await reserve(query);
    await finish(query);
    expect(
      (await read(id, { section: "movementSeries", metric: "recovered" })).rows,
    ).toEqual([{ bucketStartMs: today, value: 0 }]);
    const input = {
      publicationId: id,
      section: "movementSeries",
      metric: "installed",
      limit: 2,
    } as const;
    const cursor = createInsightsReportPageCursor(
      input,
      String(today / day - 1),
    );
    expect(
      (
        await read(
          id,
          { section: "movementSeries", metric: "installed" },
          2,
          cursor,
        )
      ).rows,
    ).toEqual([
      { bucketStartMs: today - day, value: 0 },
      { bucketStartMs: today, value: 0 },
    ]);
    const beyond = createInsightsReportPageCursor(input, "9223372036854775807");
    await expect(
      pages.pageReport({ ...input, cursor: beyond }),
    ).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("does not treat deleted ordered rows as exhaustion or publish when a required order section is missing", async () => {
    await plugin.models.insights.append(event(1, cutoff - 1));
    const query = { kind: "installationOverview" } as const;
    const id = await reserve(query);
    for (let i = 0; i < 100; i++) {
      const result = await worker.runStep({ maxItems: 256, maxRequests: 128 });
      expect(result.state).toBe("progress");
      const checkpoint = (
        await sql<{
          checkpoint: { phase: string };
        }>`select checkpoint from private_hot_updater_insights_report_jobs where id = ${id}::uuid`.execute(
          db,
        )
      ).rows[0]!.checkpoint;
      if (checkpoint.phase === "complete") break;
    }
    await sql`delete from private_hot_updater_insights_report_order_states where job_id = ${id}::uuid`.execute(
      db,
    );
    await expect(
      worker.runStep({ maxItems: 256, maxRequests: 128 }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect(await jobs.getReport({ query })).toMatchObject({
      state: "failed",
      previous: null,
    });
    const detail = {
      kind: "bundleDetail",
      bundleId: bundleA,
      window: "all",
    } as const;
    const detailId = await reserve(detail);
    await finish(detail);
    await sql`delete from private_hot_updater_insights_report_order_rows where job_id = ${detailId}::uuid and section = 'movementCohorts' and metric = 'installed'`.execute(
      db,
    );
    await expect(
      pages.pageReport({
        publicationId: detailId,
        section: "movementCohorts",
        metric: "installed",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("keeps boundary timestamps exact and rejects an unrepresentable flat cursor total", async () => {
    const query = { kind: "activeOverview", window: "7d" } as const;
    const id = await reserve(query, 0);
    const publication = await finish(query, 0);
    expect((await read(id, { section: "activeSeries" })).rows).toEqual(
      Array.from({ length: 7 }, (_, i) => ({
        bucketStartMs: (i - 7) * day,
        value: 0,
      })),
    );
    // Historical state at the supported numeric boundary, without pretending
    // the real DB clock can reserve a publication from the distant future.
    const maximum = Number.MAX_SAFE_INTEGER;
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms = ${maximum},
      publication = ${JSON.stringify({ ...publication, asOfMs: maximum, completedAtMs: maximum })}::json
      where id = ${id}::uuid`.execute(db);
    expect((await read(id, { section: "activeSeries" })).rows).toEqual(
      Array.from({ length: 7 }, (_, i) => ({
        bucketStartMs: maximum - (7 - i) * day,
        value: 0,
      })),
    );
    const overflow = 9_223_372_036_854_775_807n / 7n + 1n;
    await sql`update private_hot_updater_insights_report_order_states
      set total_rows = ${overflow.toString()}::bigint, sort_pass = 56, after_count_key = ${"0".repeat(64)}
      where job_id = ${id}::uuid and section = 'activeBundleTotals'`.execute(
      db,
    );
    statements = [];
    await expect(
      pages.pageReport({
        publicationId: id,
        section: "activeBundleSeries",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect(
      statements.some((query) =>
        /from "private_hot_updater_insights_report_order_rows"/.test(query),
      ),
    ).toBe(false);
  });
});
