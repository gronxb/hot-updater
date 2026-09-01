import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleEventRow,
  InsightsReportInput,
} from "@hot-updater/plugin-core";
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
import { readPostgresInsightsAliasPage } from "./postgresInsightsAliases";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import { readPostgresInsightsLatestByKey } from "./postgresInsightsReportData";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import { createPostgresInsightsSourceTools } from "./postgresInsightsSource";
import type { Database } from "./types";

const hour = 3_600_000;
const day = 24 * hour;
const asOfMs = Date.UTC(2026, 0, 10, 12, 34, 56);
const bundleA = createBundleEventRowFixture("1", 1).to_bundle_id;
const bundleB = createBundleEventRowFixture("2", 1).to_bundle_id;
const event = (
  id: number,
  receivedAtMs: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    ...createBundleEventRowFixture(String(id), receivedAtMs),
    to_bundle_id: bundleA,
    ...overrides,
  }) as BundleEventRow;

describe("resumable PostgreSQL exact report accumulation", () => {
  let client: PGlite;
  let db: Kysely<Database>;
  let plugin: ReturnType<typeof postgres>;
  let jobs: ReturnType<typeof createPostgresInsightsJobs<Database>>;
  let worker: ReturnType<typeof createPostgresInsightsReportWorker>;
  let requests = 0;
  let rawQueries = 0;
  let returnedRows = 0;
  let largestStep = { requests: 0, rows: 0 };

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    db = new Kysely<Database>({
      dialect: new PGliteDialect(client),
      log: (event) => {
        requests++;
        if (/from\s+"?bundle_events"?\b/i.test(event.query.sql)) rawQueries++;
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
    await migratePostgresInsightsReports(db);
    await createPostgresInsightsSourceTools(db).backfillStep(1);
    await migratePostgresInsightsLive(db);
    await createPostgresInsightsLiveTools(db).backfillStep(1);
    jobs = createPostgresInsightsJobs(db);
    worker = createPostgresInsightsReportWorker(db);
    largestStep = { requests: 0, rows: 0 };
  });
  afterEach(async () => {
    await plugin.dispose?.();
  });

  const reserve = async (input: InsightsReportInput, cutoff = asOfMs) => {
    const result = await jobs.getReport(input);
    if (result.state !== "queued") throw new Error("Expected new durable job.");
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms = ${cutoff} where id = ${result.jobId}::uuid`.execute(
      db,
    );
    return result.jobId;
  };
  const step = async () => {
    requests = 0;
    returnedRows = 0;
    try {
      return await worker.runStep({ maxItems: 256, maxRequests: 128 });
    } finally {
      expect(requests).toBeLessThanOrEqual(128);
      expect(returnedRows).toBeLessThanOrEqual(256);
      largestStep.requests = Math.max(largestStep.requests, requests);
      largestStep.rows = Math.max(largestStep.rows, returnedRows);
    }
  };
  const finish = async (input: InsightsReportInput) => {
    for (let i = 0; i < 300; i++) {
      const result = await step();
      if (result.state === "published") {
        const report = await jobs.getReport(input);
        if (report.state !== "ready")
          throw new Error("Expected complete publication.");
        return report.publication;
      }
      expect(result.state).toBe("progress");
    }
    throw new Error("Report made no bounded completion progress.");
  };

  it("rejects hostile report column and relationship catalog changes", async () => {
    await client.exec(
      "alter table private_hot_updater_insights_report_heads alter column canonical_query type jsonb using canonical_query::jsonb",
    );
    await expect(migratePostgresInsightsReports(db)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await client.exec(
      "alter table private_hot_updater_insights_report_heads alter column canonical_query type json using canonical_query::json",
    );

    await client.exec(
      "alter table private_hot_updater_insights_report_heads drop constraint private_hot_updater_insights_report_hea_publication_job_id_fkey",
    );
    await expect(migratePostgresInsightsReports(db)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await client.exec(
      "alter table private_hot_updater_insights_report_heads add foreign key(publication_job_id) references private_hot_updater_insights_report_jobs(id)",
    );

    await client.exec(
      "alter table private_hot_updater_insights_report_jobs drop constraint private_hot_updater_insights_report_jobs_query_key_fkey",
    );
    await expect(migratePostgresInsightsReports(db)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await client.exec(
      "alter table private_hot_updater_insights_report_jobs add foreign key(query_key) references private_hot_updater_insights_report_heads(query_key)",
    );
    await expect(migratePostgresInsightsReports(db)).resolves.toBeUndefined();
  });
  const counts = async (jobId: string, section: string) =>
    (
      await sql<{
        metric: string;
        label: string;
        bucket_start_ms: string;
        value: string;
      }>`
      select metric, label, bucket_start_ms::text, value::text from private_hot_updater_insights_report_counts
      where job_id = ${jobId}::uuid and section = ${section}`.execute(db)
    ).rows;

  it("deduplicates summary, UTC buckets and cohorts independently, including long old cohort labels", async () => {
    const longCohort = Array.from({ length: 1000 }, (_, i) =>
      String.fromCharCode(0x400 + ((i * 17) % 1000)),
    ).join("");
    const boundary = Math.floor(asOfMs / day) * day;
    const rows = [
      event(1, boundary - day, { install_id: "first", cohort: longCohort }),
      event(2, boundary - day + 1, { install_id: "first", cohort: longCohort }),
      event(3, boundary + 1, { install_id: "first", cohort: "second" }),
      event(4, boundary + 2, { install_id: "second", cohort: longCohort }),
      event(5, boundary + 3, {
        type: "RECOVERED",
        install_id: "first",
        from_bundle_id: bundleA,
        to_bundle_id: bundleB,
      }),
      event(6, asOfMs, { install_id: "excluded-at-cutoff" }),
      event(7, boundary + 4, {
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      }),
    ];
    for (const row of rows.reverse()) await plugin.models.insights.append(row);
    const input: InsightsReportInput = {
      query: { kind: "bundleDetail", bundleId: bundleA, window: "all" },
    };
    const id = await reserve(input);
    const result = await finish(input);
    expect(result).toMatchObject({
      id,
      asOfMs,
      accuracy: "exact",
      summary: { installed: 2, recovered: 1 },
    });
    expect(await counts(id, "movementSeries")).toEqual(
      expect.arrayContaining([
        {
          metric: "installed",
          label: "",
          bucket_start_ms: String(boundary - day),
          value: "1",
        },
        {
          metric: "installed",
          label: "",
          bucket_start_ms: String(boundary),
          value: "2",
        },
      ]),
    );
    expect(await counts(id, "movementCohorts")).toEqual(
      expect.arrayContaining([
        {
          metric: "installed",
          label: longCohort,
          bucket_start_ms: "-1",
          value: "2",
        },
        {
          metric: "installed",
          label: "second",
          bucket_start_ms: "-1",
          value: "1",
        },
      ]),
    );
    const batch = {
      query: {
        kind: "bundleSummaries",
        bundleIds: [bundleB, bundleA, bundleA],
        window: "all",
      },
    } as const;
    const batchId = await reserve(batch);
    const summary = await finish(batch);
    expect(summary.summary).toEqual([
      { bundleId: bundleA, installed: 2, recovered: 1 },
      { bundleId: bundleB, installed: 0, recovered: 0 },
    ]);
    expect(await counts(batchId, "movementSeries")).toEqual([]);
    expect(await counts(batchId, "movementCohorts")).toEqual([]);
  });

  it("matches the active reference after identity changes and counts all30 shifted buckets within both budgets", async () => {
    const start = asOfMs - 30 * day;
    const rows = Array.from({ length: 30 }, (_, i) =>
      event(i + 1, start + i * day, {
        install_id: "retained",
        user_id: i === 29 ? "selected" : "previous",
        to_bundle_id: i % 2 === 0 ? bundleA : bundleB,
      }),
    );
    rows.push(
      event(40, asOfMs - hour, { install_id: "excluded", user_id: "selected" }),
      event(41, asOfMs - 1, { install_id: "excluded", user_id: "other" }),
      event(42, start - 1, { install_id: "too-old", user_id: "selected" }),
      event(43, asOfMs, { install_id: "future", user_id: "selected" }),
      event(44, asOfMs - 10, { install_id: "tie", user_id: "other" }),
      event(45, asOfMs - 10, {
        install_id: "tie",
        user_id: "selected",
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      }),
    );
    for (const row of [...rows].reverse())
      await plugin.models.insights.append(row);
    const input = {
      query: { kind: "activeOverview", window: "30d", userId: "selected" },
    } as const;
    const id = await reserve(input);
    const actual = await finish(input);
    const expected = collectActiveInstallationOverview({
      rows,
      asOfMs,
      window: "30d",
      userId: "selected",
    });
    expect(actual.summary).toEqual({
      activeInstallations: expected.activeInstallations,
    });
    expect(await counts(id, "bundleDistribution")).toEqual(
      expect.arrayContaining(
        expected.bundles.map((row) => ({
          metric: "",
          label: row.bundleId,
          bucket_start_ms: "-1",
          value: String(row.installations),
        })),
      ),
    );
    const series = await counts(id, "activeSeries");
    expect(series).toHaveLength(30);
    expect(series).toEqual(
      expect.arrayContaining(
        expected.series.map((row) => ({
          metric: "",
          label: "",
          bucket_start_ms: String(row.bucketStartMs),
          value: String(row.value),
        })),
      ),
    );
    for (const bundle of expected.bundleSeries) {
      const actualBuckets = (await counts(id, "activeBundleSeries")).filter(
        (row) => row.label === bundle.bundleId,
      );
      expect(actualBuckets).toEqual(
        expect.arrayContaining(
          bundle.series
            .filter((row) => row.value > 0)
            .map((row) => ({
              metric: "",
              label: bundle.bundleId,
              bucket_start_ms: String(row.bucketStartMs),
              value: String(row.value),
            })),
        ),
      );
    }
    expect(largestStep.requests).toBeGreaterThan(90);
    expect(largestStep.rows).toBeGreaterThan(120);
  });

  it("publishes the saved source prefix and reuses it while a fresh report prepares", async () => {
    await plugin.models.insights.append(event(1, asOfMs - 100));
    const input = { query: { kind: "installationOverview" } } as const;
    const firstId = await reserve(input);
    expect(await step()).toMatchObject({ state: "progress", processed: 0 });
    await plugin.models.insights.append(event(2, asOfMs - 200));
    const first = await finish(input);
    expect(first).toMatchObject({
      id: firstId,
      summary: { trackedInstallations: 1 },
    });
    const fresh = { ...input, minAsOfMs: asOfMs + 1 };
    const next = await jobs.getReport(fresh);
    expect(next).toMatchObject({ state: "queued", previous: first });
    if (next.state !== "queued") throw new Error("Expected refresh job.");
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms = ${asOfMs + 1} where id = ${next.jobId}::uuid`.execute(
      db,
    );
    expect(
      await jobs.getReport({ ...input, minAsOfMs: asOfMs + 2 }),
    ).toMatchObject({ state: "queued", jobId: next.jobId });
    expect(await jobs.getReport(input)).toEqual({
      state: "ready",
      publication: first,
    });
    const second = await finish(fresh);
    expect(second).toMatchObject({ summary: { trackedInstallations: 2 } });
    expect(second.sourceGeneration).not.toBe(first.sourceGeneration);
    expect(await counts(firstId, "installations")).toMatchObject([
      { value: "1" },
    ]);
  });

  it("keeps the reserved job recoverable until source preparation finishes", async () => {
    await plugin.models.insights.append(event(1, asOfMs - 1));
    const input = { query: { kind: "installationOverview" } } as const;
    const id = await reserve(input);
    await sql`update private_hot_updater_insights_source_state set ready = false where id = 1`.execute(
      db,
    );
    expect(await step()).toEqual({
      state: "not-ready",
      processed: 0,
      jobId: id,
    });
    expect(await jobs.getReport(input)).toMatchObject({
      state: "queued",
      jobId: id,
      previous: null,
    });
    await sql`update private_hot_updater_insights_source_state set ready = true where id = 1`.execute(
      db,
    );
    expect(await finish(input)).toMatchObject({
      id,
      summary: { trackedInstallations: 1 },
    });
  });

  it("freezes historical aliases and latest metadata at the same source prefix and time cutoff", async () => {
    const old = event(100, asOfMs - 100, {
      install_id: "Installation-A",
      user_id: "Former-User",
      username: "Legacy Name",
    });
    const latest = event(101, asOfMs - 10, {
      install_id: old.install_id,
      user_id: "Current-User",
      username: null,
      to_bundle_id: bundleB,
    });
    // The user changed, but searching their former identity must still return
    // this installation with its latest metadata, not the old matching event.
    await plugin.models.insights.append(old);
    await plugin.models.insights.append(latest);
    for (let i = 0; i < 40; i++)
      await plugin.models.insights.append({ ...old, id: event(200 + i, 1).id });
    await plugin.models.insights.append(
      event(300, asOfMs, {
        install_id: old.install_id,
        user_id: "Cutoff-User",
      }),
    );
    const input = { query: { kind: "installationOverview" } } as const;
    const id = await reserve(input);
    // Reservation has already frozen the committed source before this
    // backdated append and before any worker lease.
    await plugin.models.insights.append(
      event(301, asOfMs - 1, {
        install_id: old.install_id,
        user_id: "Late-User",
      }),
    );
    const first = await finish(input);
    expect(first).toMatchObject({
      id,
      asOfMs,
      summary: { trackedInstallations: 1 },
    });
    rawQueries = 0;
    const aliases = await readPostgresInsightsAliasPage(db, id, null, 200);
    expect(aliases.map((row) => row.normalizedAlias).sort()).toEqual([
      "current-user",
      "former-user",
      "installation-a",
      "legacy name",
    ]);
    expect(
      await readPostgresInsightsLatestByKey(
        db,
        id,
        aliases
          .filter((row) => row.normalizedAlias.includes("former"))
          .map((row) => row.installKey),
      ),
    ).toEqual([{ installKey: aliases[0]!.installKey, event: latest }]);
    expect(rawQueries).toBe(0);

    const refreshed = { ...input, minAsOfMs: asOfMs + 1 };
    const nextId = await reserve(refreshed, asOfMs + 1);
    await finish(refreshed);
    expect(
      (await readPostgresInsightsAliasPage(db, nextId, null, 200)).map(
        (row) => row.normalizedAlias,
      ),
    ).toEqual(expect.arrayContaining(["cutoff-user", "late-user"]));
    expect(await readPostgresInsightsAliasPage(db, id, null, 200)).toEqual(
      aliases,
    );
    expect(
      await readPostgresInsightsLatestByKey(db, id, [aliases[0]!.installKey]),
    ).toEqual([{ installKey: aliases[0]!.installKey, event: latest }]);
  });

  it("rolls back an operational alias failure and retries after lease expiry", async () => {
    await plugin.models.insights.append(event(1, asOfMs - 1));
    const input = { query: { kind: "installationOverview" } } as const;
    const id = await reserve(input);
    await step();
    await client.exec(`create function fail_alias() returns trigger language plpgsql as $$
      begin raise exception 'injected alias failure'; end $$;
      create trigger fail_alias before insert on private_hot_updater_insights_report_aliases for each row execute function fail_alias();`);
    let thrown: unknown;
    for (let i = 0; i < 17; i++) {
      try {
        await step();
      } catch (error) {
        thrown = error;
        break;
      }
    }
    expect(thrown).toMatchObject({ message: "injected alias failure" });
    expect(await jobs.getReport(input)).toMatchObject({
      state: "preparing",
      jobId: id,
    });
    const stored = await sql<{ checkpoint: { afterSequence: string } }>`
      select checkpoint from private_hot_updater_insights_report_jobs where id = ${id}::uuid`.execute(
      db,
    );
    expect(stored.rows[0]!.checkpoint.afterSequence).toBe("0");
    expect(
      (
        await sql`select * from private_hot_updater_insights_report_latest where job_id = ${id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await sql`select * from private_hot_updater_insights_report_aliases where job_id = ${id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    expect(await step()).toMatchObject({ state: "idle" });
    await client.exec(
      "drop trigger fail_alias on private_hot_updater_insights_report_aliases; drop function fail_alias(); update private_hot_updater_insights_report_jobs set claimable_at=clock_timestamp() where id='" +
        id +
        "'::uuid",
    );
    expect(await finish(input)).toMatchObject({ id });
  });

  it("preserves valid zero-match report selectors", async () => {
    await plugin.models.insights.append(event(1, asOfMs - 1));
    const batch = {
      query: {
        kind: "bundleSummaries",
        bundleIds: ["missing-bundle"],
        window: "all",
      },
    } as const;
    await reserve(batch);
    expect(await finish(batch)).toMatchObject({
      summary: [{ bundleId: "missing-bundle", installed: 0, recovered: 0 }],
    });
    const active = {
      query: {
        kind: "activeOverview",
        window: "24h",
        userId: "missing-user",
      },
    } as const;
    await reserve(active);
    expect(await finish(active)).toMatchObject({
      summary: { activeInstallations: 0 },
    });
  });

  it("publishes an empty batch after source capture without reading any raw events", async () => {
    await plugin.models.insights.append(event(1, asOfMs - 1));
    const input = {
      query: { kind: "bundleSummaries", bundleIds: [], window: "all" },
    } as const;
    const id = await reserve(input);
    rawQueries = 0;
    expect(await step()).toMatchObject({ state: "published", processed: 0 });
    expect(rawQueries).toBe(0);
    expect(await jobs.getReport(input)).toMatchObject({
      state: "ready",
      publication: { id, summary: [] },
    });
  });

  it("rolls back an operational count batch and retries without partial counters", async () => {
    await plugin.models.insights.append(event(1, asOfMs - 1));
    const input = {
      query: { kind: "bundleDetail", bundleId: bundleA, window: "all" },
    } as const;
    const id = await reserve(input);
    await step();
    await client.exec(`create function fail_report_count() returns trigger language plpgsql as $$
      begin if new.section = 'movementCohorts' then raise exception 'injected late batch failure'; end if; return new; end $$;
      create trigger fail_count before insert on private_hot_updater_insights_report_counts for each row execute function fail_report_count();`);
    let thrown: unknown;
    for (let i = 0; i < 17; i++) {
      try {
        await step();
      } catch (error) {
        thrown = error;
        break;
      }
    }
    expect(thrown).toMatchObject({ message: "injected late batch failure" });
    expect(await jobs.getReport(input)).toMatchObject({
      state: "preparing",
      jobId: id,
    });
    expect(
      (
        await sql`select * from private_hot_updater_insights_report_members where job_id = ${id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    await client.exec(
      "drop trigger fail_count on private_hot_updater_insights_report_counts; drop function fail_report_count(); update private_hot_updater_insights_report_jobs set claimable_at=clock_timestamp() where id='" +
        id +
        "'::uuid",
    );
    expect(await finish(input)).toMatchObject({ id });
    expect(
      (
        await sql`select * from private_hot_updater_insights_report_counts where job_id = ${id}::uuid`.execute(
          db,
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    expect(await step()).toMatchObject({ state: "idle" });
  });

  it("finishes beyond50,000 raw events in bounded steps and rejects a dropped projection index before claiming", async () => {
    const base = JSON.stringify(event(1, asOfMs - 1));
    // Bulk fixture creation is outside the worker budget. Match the production
    // UUID→SHA256→16shard assignment and contiguous committed shard sequences.
    await sql`with ids as (
      select n, '10000000-0000-7000-8000-' || lpad(n::text, 12, '0') as id
      from generate_series(1, 50001) n
    ), sharded as (
      select *, get_byte(sha256(convert_to(id, 'UTF8')), 0) % 16 as shard from ids
    ), source as (
      select *, row_number() over (partition by shard order by n) as sequence from sharded
    ), events as (
      select *, ${base}::jsonb || jsonb_build_object('id', id,
        'install_id', 'install-' || n,
        'received_at_ms', ${asOfMs}::bigint - 50002 + n,
        'type', case when n = 50001 then 'UPDATE_APPLIED' else 'UNCHANGED' end,
        'from_bundle_id', case when n = 50001 then ${bundleB}::text else null end,
        'update_strategy', case when n = 50001 then 'appVersion' else null end) event
      from source
    ) insert into bundle_events select (jsonb_populate_record(null::bundle_events,
      event || jsonb_build_object('insights_source_shard', shard,
        'insights_source_seq', sequence, 'insights_event', event,
        'insights_live_version', 1))).* from events`.execute(db);
    await sql`update private_hot_updater_insights_source_clocks c set committed_seq = s.last_sequence
      from (select insights_source_shard, max(insights_source_seq) as last_sequence
        from bundle_events group by insights_source_shard) s where c.shard = s.insights_source_shard`.execute(
      db,
    );
    const input = {
      query: { kind: "bundleSummaries", bundleIds: [bundleA], window: "all" },
    } as const;
    const id = await reserve(input);
    await client.exec("drop index insights_report_latest_installations_idx");
    await expect(
      worker.runStep({ maxItems: 4096, maxRequests: 4096 }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(await jobs.getReport(input)).toMatchObject({
      state: "queued",
      jobId: id,
    });
    await client.exec(
      "create index insights_report_latest_installations_idx on private_hot_updater_insights_report_latest(job_id, bucket_index, install_key)",
    );
    let processed = 0;
    let published = false;
    for (let i = 0; i < 300; i++) {
      requests = 0;
      returnedRows = 0;
      const result = await worker.runStep({
        maxItems: 4096,
        maxRequests: 4096,
      });
      expect(requests).toBeLessThanOrEqual(4096);
      expect(returnedRows).toBeLessThanOrEqual(4096);
      expect(result.processed).toBeLessThanOrEqual(200);
      processed += result.processed;
      if (result.state === "published") {
        published = true;
        break;
      }
      expect(result.state).toBe("progress");
    }
    expect(published).toBe(true);
    expect(processed).toBe(50001);
    expect(await jobs.getReport(input)).toMatchObject({
      state: "ready",
      publication: {
        id,
        summary: [{ bundleId: bundleA, installed: 1, recovered: 0 }],
        accuracy: "exact",
      },
    });
  });
});
