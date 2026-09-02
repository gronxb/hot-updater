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

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000f001";

const day = 86_400_000;
const cutoff = Date.UTC(2026, 0, 11, 12, 34, 56);
const today = Math.floor(cutoff / day) * day;
const bundleA = createBundleEventRowFixture("1", 1).to_bundle_id;
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
    plugin = postgres({
      insightsDatabaseNamespace,
      dialect: new PGliteDialect(client),
    });
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
    jobs = createPostgresInsightsJobs(db, insightsDatabaseNamespace);
    worker = createPostgresInsightsReportWorker(db, insightsDatabaseNamespace);
    pages = createPostgresInsightsReportPages(db, insightsDatabaseNamespace);
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
    expect(statements[0]).toMatch(/repeatable read/i);
    expect(statements.length).toBeLessThanOrEqual(13);
    expect(returnedRows).toBeLessThanOrEqual(limit * 2 + 11);
    if (result.state !== "ready") throw new Error("Expected page.");
    return result;
  };

  it("uses indexed deep series cursors and rejects out-of-range ordinals", async () => {
    await plugin.models.insights.append(event(1, 0));
    const query = {
      kind: "bundleDetail",
      bundleId: bundleA,
      window: "all",
    } as const;
    const id = await reserve(query);
    await finish(query);
    const input = {
      publicationId: id,
      section: "movementSeries",
      metric: "installed",
      limit: 2,
    } as const;
    const cursor = createInsightsReportPageCursor(
      input,
      String(today / day - 1),
      insightsDatabaseNamespace,
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
    const beyond = createInsightsReportPageCursor(
      input,
      "9223372036854775807",
      insightsDatabaseNamespace,
    );
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
