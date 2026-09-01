import { randomUUID } from "node:crypto";

import type {
  BundleEventRow,
  InsightsReportResult,
} from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createKyselyInsightsModel,
  migrateKyselyInsights,
  prepareKyselyInsightsSource,
  runKyselyInsightsMaintenanceStep,
} from ".";
import { createKyselyMigrator } from "../../../db/fixedMigrator";
import { kyselyAdapter } from "../../kysely";
import { stepKyselyInsightsSearch } from "./installations";
import { stepKyselyInsightsReport } from "./reports";
import { executeSerializable } from "./utils";

const cockroachUrl = process.env.KYSELY_INSIGHTS_COCKROACH_URL;
const databaseKinds = ["scale", "behavior", "migration", "poison"] as const;
type DatabaseKind = (typeof databaseKinds)[number];

type AppliedEvent = BundleEventRow & { readonly type: "UPDATE_APPLIED" };

const event = (
  id: string,
  installId: string,
  receivedAtMs: number,
  overrides: Partial<AppliedEvent> = {},
): BundleEventRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `Name ${installId}`,
  from_release_id: "01900000-0000-7000-8000-000000000010",
  from_bundle_id: "01900000-0000-7000-8000-000000000020",
  to_release_id: "01900000-0000-7000-8000-000000000011",
  to_bundle_id: "01900000-0000-7000-8000-000000000021",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "cohort-a",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: "1.0.0",
  received_at_ms: receivedAtMs,
  ...overrides,
});

const readyReport = async (
  run: () => Promise<InsightsReportResult>,
  advance: () => Promise<unknown>,
): Promise<Extract<InsightsReportResult, { state: "ready" }>> => {
  for (let index = 0; index < 40; index += 1) {
    const result = await run();
    if (result.state === "ready") return result;
    expect(["preparing", "stale"]).toContain(result.state);
    await advance();
  }
  throw new Error("CockroachDB report did not publish");
};

const planText = async (
  db: Kysely<object>,
  query: ReturnType<typeof sql>,
): Promise<string> => {
  const result = await sql<{
    readonly info: unknown;
  }>`explain ${query}`.execute(db);
  return result.rows.map(({ info }) => String(info)).join("\n");
};

const analyzedPlanText = async (
  db: Kysely<object>,
  query: ReturnType<typeof sql>,
): Promise<string> => {
  const result = await sql<{
    readonly info: unknown;
  }>`explain analyze ${query}`.execute(db);
  return result.rows.map(({ info }) => String(info)).join("\n");
};

const byteCount = (value: string, unit: string): number => {
  const factors: Record<string, number> = {
    B: 1,
    KiB: 1_024,
    MiB: 1_024 ** 2,
    GiB: 1_024 ** 3,
  };
  return Number(value.replaceAll(",", "")) * (factors[unit] ?? 1);
};

describe.skipIf(!cockroachUrl)("Kysely Insights CockroachDB evidence", () => {
  const names = new Map<DatabaseKind, string>();
  const urls = new Map<DatabaseKind, string>();
  const connections = new Set<Kysely<object>>();
  let admin: pg.Pool;

  const connect = (kind: DatabaseKind, max = 24): Kysely<object> => {
    const connectionString = urls.get(kind);
    if (!connectionString) throw new Error(`missing ${kind} database URL`);
    const db = new Kysely<object>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max }),
      }),
    });
    connections.add(db);
    return db;
  };

  const disconnect = async (db: Kysely<object>): Promise<void> => {
    connections.delete(db);
    await db.destroy();
  };

  const migrateFresh = async (db: Kysely<object>): Promise<void> => {
    const migration = await kyselyAdapter({
      db,
      provider: "cockroachdb",
    }).createMigrator!().migrateToLatest();
    await migration.execute();
  };

  const insertCoreEvent = async (
    db: Kysely<object>,
    row: BundleEventRow,
  ): Promise<void> => {
    await sql`insert into bundle_events (
      id, type, install_id, user_id, username, from_release_id, from_bundle_id,
      to_release_id, to_bundle_id, platform, app_version, channel, cohort,
      update_strategy, fingerprint_hash, sdk_version, received_at_ms
    ) values (
      ${row.id}, ${row.type}, ${row.install_id}, ${row.user_id},
      ${row.username}, ${row.from_release_id}, ${row.from_bundle_id},
      ${row.to_release_id}, ${row.to_bundle_id}, ${row.platform},
      ${row.app_version}, ${row.channel}, ${row.cohort},
      ${row.update_strategy}, ${row.fingerprint_hash}, ${row.sdk_version},
      ${row.received_at_ms}
    )`.execute(db);
  };

  beforeAll(async () => {
    if (!cockroachUrl) throw new Error("missing CockroachDB evidence URL");
    const adminUrl = new URL(cockroachUrl);
    adminUrl.pathname = "/defaultdb";
    admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
    const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
    for (const kind of databaseKinds) {
      const name = `hot_updater_kysely_${kind}_${suffix}`;
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe database name");
      await admin.query(`create database "${name}"`);
      const url = new URL(cockroachUrl);
      url.pathname = `/${name}`;
      names.set(kind, name);
      urls.set(kind, url.toString());
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      [...connections].map(async (db) => {
        try {
          await db.destroy();
        } finally {
          connections.delete(db);
        }
      }),
    );
    for (const name of [...names.values()].reverse()) {
      await admin.query(`drop database if exists "${name}" cascade`);
    }
    await admin.end();
  }, 180_000);

  it("runs rev4 BYTES DDL and a bounded 50,001-row DistSQL page", async () => {
    const db = connect("scale");
    await migrateFresh(db);

    const state = await sql<{
      readonly layout_revision: unknown;
      readonly ready: unknown;
    }>`select layout_revision, ready
        from private_hot_updater_kysely_insights_state where id = 1`.execute(
      db,
    );
    expect(Number(state.rows[0]?.layout_revision)).toBe(4);
    expect(state.rows[0]?.ready).toBe(true);

    const jobColumns = await sql<{
      readonly column_name: string;
      readonly data_type: string;
    }>`show columns from private_hot_updater_kysely_insights_report_jobs`.execute(
      db,
    );
    expect(
      jobColumns.rows
        .find(({ column_name }) => column_name === "order_after_label")
        ?.data_type.toUpperCase(),
    ).toContain("BYTES");
    const countColumns = await sql<{
      readonly column_name: string;
      readonly data_type: string;
    }>`show columns from private_hot_updater_kysely_insights_report_counts`.execute(
      db,
    );
    expect(
      countColumns.rows
        .find(({ column_name }) => column_name === "label_order")
        ?.data_type.toUpperCase(),
    ).toContain("BYTES");

    await sql`insert into private_hot_updater_kysely_insights_events
        (event_id, source_seq, received_at_ms, install_key, install_id,
          event_type, to_bundle_id, from_bundle_id, raw_json)
        select event_id, n, n, sha256(('"' || install_id || '"')::bytes),
          install_id, 'UPDATE_APPLIED',
          '01900000-0000-7000-8000-000000000021',
          '01900000-0000-7000-8000-000000000020',
          jsonb_build_object(
            'id', event_id, 'type', 'UPDATE_APPLIED',
            'install_id', install_id, 'user_id', 'user-' || install_id,
            'username', 'Name ' || install_id,
            'from_release_id', '01900000-0000-7000-8000-000000000010',
            'from_bundle_id', '01900000-0000-7000-8000-000000000020',
            'to_release_id', '01900000-0000-7000-8000-000000000011',
            'to_bundle_id', '01900000-0000-7000-8000-000000000021',
            'platform', 'ios', 'app_version', '1.0.0',
            'channel', 'production', 'cohort', 'cohort-a',
            'update_strategy', 'appVersion', 'fingerprint_hash', null,
            'sdk_version', '1.0.0', 'received_at_ms', n
          )::string
        from (
          select n,
            ('10000000-0000-7000-8000-' || lpad(n::string, 12, '0'))
              as event_id,
            ('bulk-' || n::string) as install_id
          from generate_series(1, 50001) as generated(n)
        )`.execute(db);
    await sql`update private_hot_updater_kysely_insights_state
        set next_seq = 50001 where id = 1`.execute(db);

    const insights = createKyselyInsightsModel(db, "cockroachdb");
    const page = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 60_000,
      limit: 100,
    });
    expect(page.state).toBe("ready");
    if (page.state !== "ready") return;
    expect(page.data.data).toHaveLength(100);
    expect(page.data.nextCursor).not.toBeNull();

    const query = sql`select event_id, source_seq, received_at_ms,
          install_key, install_id, raw_json
        from private_hot_updater_kysely_insights_events
        where received_at_ms >= 0 and received_at_ms < 60000
        order by received_at_ms desc, event_id desc limit 101`;
    const plan = await planText(db, query);
    expect(plan).toContain("kysely_insights_events_order_idx");
    expect(plan.toLowerCase()).not.toContain("sort");
    const analyzed = await analyzedPlanText(db, query);
    expect(analyzed).toContain("kysely_insights_events_order_idx");
    expect(analyzed).toMatch(/limit: 101/i);
    const decoded = analyzed.match(/rows decoded from KV: ([\d,]+)/i);
    expect(decoded).not.toBeNull();
    expect(Number(decoded![1]!.replaceAll(",", ""))).toBeLessThanOrEqual(101);
    const bytes = analyzed.match(/KV bytes read: ([\d,.]+)\s+(B|KiB|MiB|GiB)/i);
    expect(bytes).not.toBeNull();
    expect(byteCount(bytes![1]!, bytes![2]!)).toBeLessThan(4 * 1_024 ** 2);
  }, 180_000);

  it("keeps concurrent writes, delayed publications, and zero-filled reports exact", async () => {
    const db = connect("behavior");
    const worker = connect("behavior");
    await migrateFresh(db);
    const insights = createKyselyInsightsModel(db, "cockroachdb");
    const advance = () =>
      runKyselyInsightsMaintenanceStep(db, "cockroachdb", {
        maxItems: 160,
        maxRequests: 4_096,
      });

    await insights.append(
      event("019a2000-0000-7000-8000-000000000001", "delayed-a", 200, {
        user_id: "current-user",
      }),
    );
    await insights.append(
      event("019a2000-0000-7000-8000-000000000002", "delayed-a", 100, {
        user_id: "historical-user",
      }),
    );
    await insights.append(
      event("019a2000-0000-7000-8000-000000000003", "delayed-b", 150, {
        user_id: "historical-user",
      }),
    );
    await expect(
      insights.pageInstallations({
        kind: "installationId",
        installId: "delayed-a",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ user_id: "current-user" }] },
    });

    const pending = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 1,
    });
    expect(pending.state).toBe("preparing");
    if (pending.state !== "preparing") return;
    const searchSteps = await Promise.all([
      stepKyselyInsightsSearch(db, "cockroachdb", pending.job.id),
      stepKyselyInsightsSearch(worker, "cockroachdb", pending.job.id),
    ]);
    expect(searchSteps.map(({ advanced }) => advanced).sort()).toEqual([
      false,
      true,
    ]);
    const publicationA = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      limit: 1,
    });
    expect(publicationA.state).toBe("ready");
    if (
      publicationA.state !== "ready" ||
      publicationA.data.nextCursor === null
    ) {
      return;
    }
    const publication = publicationA.data.consistency.cutoff.publication;
    expect(publicationA.data.total.value).toBe(2);

    await insights.append(
      event("019a2000-0000-7000-8000-000000000004", "delayed-c", 250, {
        user_id: "historical-user",
      }),
    );
    await expect(
      insights.pageInstallations({
        kind: "userId",
        userId: "historical-user",
        minAsOfMs: publication.asOfMs + 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({ state: "stale" });
    await advance();
    await expect(
      insights.pageInstallations({
        kind: "userId",
        userId: "historical-user",
        minAsOfMs: publication.asOfMs + 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({ state: "ready", data: { total: { value: 3 } } });
    const retainedA = await insights.pageInstallations({
      kind: "userId",
      userId: "historical-user",
      cursor: publicationA.data.nextCursor,
      limit: 1,
    });
    expect(retainedA.state).toBe("ready");
    if (retainedA.state === "ready") {
      expect(retainedA.data.consistency.cutoff.publication.id).toBe(
        publication.id,
      );
      expect(
        [...publicationA.data.data, ...retainedA.data.data].find(
          ({ install_id }) => install_id === "delayed-a",
        )?.user_id,
      ).toBe("current-user");
    }

    const rejected = event(
      "019e0000-0000-7000-8000-000000000001",
      "rollback-install",
      1_000,
    );
    await sql
      .raw(`alter table private_hot_updater_kysely_insights_events
        add constraint reject_runtime_append
        check (event_id != '${rejected.id}')`)
      .execute(db);
    const before = await sql<{
      readonly next_seq: unknown;
    }>`select next_seq from private_hot_updater_kysely_insights_state
        where id = 1`.execute(db);
    await expect(insights.append(rejected)).rejects.toThrow();
    const afterRejected = await sql<{
      readonly next_seq: unknown;
      readonly core_count: unknown;
    }>`select next_seq,
          (select count(*) from bundle_events where id = ${rejected.id})
            as core_count
        from private_hot_updater_kysely_insights_state where id = 1`.execute(
      db,
    );
    expect(Number(afterRejected.rows[0]?.next_seq)).toBe(
      Number(before.rows[0]?.next_seq),
    );
    expect(Number(afterRejected.rows[0]?.core_count)).toBe(0);

    const concurrent = Array.from({ length: 16 }, (_, index) =>
      event(
        `019e${(index + 1).toString(16).padStart(4, "0")}-0000-7000-8000-${(
          index + 2
        )
          .toString(16)
          .padStart(12, "0")}`,
        `concurrent-${index}`,
        1_100 + index,
      ),
    );
    await Promise.all(concurrent.map((row) => insights.append(row)));
    const sourceRows = await sql<{
      readonly source_seq: unknown;
    }>`select source_seq from private_hot_updater_kysely_insights_events
        where install_id like 'concurrent-%' order by source_seq`.execute(db);
    expect(sourceRows.rows).toHaveLength(16);
    const sequences = sourceRows.rows.map(({ source_seq }) =>
      Number(source_seq),
    );
    expect(sequences).toEqual(
      Array.from({ length: 16 }, (_, index) => sequences[0]! + index),
    );

    await sql`create table serializable_retry_probe (
        id integer primary key, value integer not null
      )`.execute(db);
    await sql`insert into serializable_retry_probe values (1, 0)`.execute(db);
    let firstReads = 0;
    let releaseReads: (() => void) | undefined;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const attempts = [0, 0];
    const increment = (index: number, connection: Kysely<object>) =>
      executeSerializable(connection, "cockroachdb", async (transaction) => {
        attempts[index] += 1;
        const current = await sql<{
          readonly value: unknown;
        }>`select value from serializable_retry_probe where id = 1`.execute(
          transaction,
        );
        if (attempts[index] === 1) {
          firstReads += 1;
          if (firstReads === 2) releaseReads?.();
          await bothRead;
        }
        await sql`update serializable_retry_probe
            set value = ${Number(current.rows[0]?.value) + 1}
            where id = 1`.execute(transaction);
      });
    await Promise.all([increment(0, db), increment(1, worker)]);
    const retryValue = await sql<{
      readonly value: unknown;
    }>`select value from serializable_retry_probe where id = 1`.execute(db);
    expect(Number(retryValue.rows[0]?.value)).toBe(2);
    expect(attempts.sort()).toEqual([1, 2]);

    const reportBundle = "01900000-0000-7000-8000-000000000031";
    const labels = ["😀", "é", "Z", "a"];
    const now = Date.now();
    for (const [labelIndex, cohort] of labels.entries()) {
      for (let occurrence = 0; occurrence < 2; occurrence += 1) {
        const sequence = labelIndex * 2 + occurrence + 1;
        await insights.append(
          event(
            `01a3${sequence.toString(16).padStart(4, "0")}-0000-7000-8000-${sequence
              .toString(16)
              .padStart(12, "0")}`,
            `unicode-${sequence}`,
            now - (occurrence === 0 ? 10_800_000 : 3_600_000),
            { cohort, to_bundle_id: reportBundle },
          ),
        );
      }
    }
    const reportInput = {
      query: {
        kind: "bundleDetail",
        bundleId: reportBundle,
        window: "24h",
      },
    } as const;
    const reserved = await insights.getReport(reportInput);
    expect(reserved.state).toBe("preparing");
    if (reserved.state !== "preparing") return;

    let unlock: (() => void) | undefined;
    const unlocked = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let locked: (() => void) | undefined;
    const rowLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holdJob = worker.transaction().execute(async (transaction) => {
      await sql`select id from private_hot_updater_kysely_insights_report_jobs
          where id = ${reserved.job.id} for update`.execute(transaction);
      locked?.();
      await unlocked;
    });
    await rowLocked;
    const appendResult = await Promise.race([
      insights
        .append(
          event(
            "01a40000-0000-7000-8000-000000000001",
            "append-during-report-lock",
            now,
          ),
        )
        .then(() => "appended" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 5_000),
      ),
    ]);
    expect(appendResult).toBe("appended");
    unlock?.();
    await holdJob;

    await Promise.all([
      stepKyselyInsightsReport(db, "cockroachdb", reserved.job.id, {
        maxItems: 160,
        maxRequests: 4_096,
      }),
      stepKyselyInsightsReport(worker, "cockroachdb", reserved.job.id, {
        maxItems: 160,
        maxRequests: 4_096,
      }),
    ]);
    const report = await readyReport(
      () => insights.getReport(reportInput),
      advance,
    );
    const cohorts = await insights.pageReport({
      publicationId: report.data.id,
      section: "movementCohorts",
      metric: "installed",
      limit: 10,
    });
    expect(cohorts.state).toBe("ready");
    if (cohorts.state === "ready") {
      expect(cohorts.data.data).toEqual(
        [...labels].sort().map((cohort) => ({ cohort, value: 2 })),
      );
      expect(cohorts.data.total).toMatchObject({ value: 4 });
    }
    const series = await insights.pageReport({
      publicationId: report.data.id,
      section: "movementSeries",
      metric: "installed",
      limit: 100,
    });
    expect(series.state).toBe("ready");
    if (series.state === "ready" && series.data.section === "movementSeries") {
      expect(series.data.data).toHaveLength(24);
      expect(series.data.data.filter(({ value }) => value === 0)).toHaveLength(
        22,
      );
      expect(series.data.data.reduce((sum, { value }) => sum + value, 0)).toBe(
        8,
      );
      expect(series.data.total).toMatchObject({ value: 24 });
    }

    const reportCount = await sql<{
      readonly value: unknown;
    }>`select value from private_hot_updater_kysely_insights_report_counts
        where job_id = ${report.data.id} and section = 'movementCohorts'
          and metric = 'installed' and label = 'é'`.execute(db);
    expect(Number(reportCount.rows[0]?.value)).toBe(2);

    const aliasPlan = await planText(
      db,
      sql`select install_key from private_hot_updater_kysely_insights_aliases
          where source_seq <= 100000 order by source_seq, install_key,
            alias_kind, alias_hash limit 128`,
    );
    expect(aliasPlan).toContain("kysely_insights_alias_source_idx");
    const searchWorkPlan = await planText(
      db,
      sql`select id from private_hot_updater_kysely_insights_search_jobs
          where state = 'preparing' order by as_of_ms, id limit 1`,
    );
    expect(searchWorkPlan).toContain("kysely_insights_search_work_idx");
    const reportWorkPlan = await planText(
      db,
      sql`select id from private_hot_updater_kysely_insights_report_jobs
          where state = 'preparing' order by as_of_ms, id limit 1`,
    );
    expect(reportWorkPlan).toContain("kysely_insights_report_work_idx");
    const reportOrderPlan = await planText(
      db,
      sql`select label, value
          from private_hot_updater_kysely_insights_report_counts
          where job_id = ${report.data.id} and section = 'movementCohorts'
            and metric = 'installed' and bucket_start_ms = -1
          order by label_order limit 160`,
    );
    expect(reportOrderPlan).toContain("kysely_insights_counts_order_idx");
    const reportRankPlan = await planText(
      db,
      sql`select label, value
          from private_hot_updater_kysely_insights_report_counts
          where job_id = ${report.data.id} and section = 'movementCohorts'
            and metric = 'installed' and bucket_start_ms = -1
          order by value desc, label_order limit 160`,
    );
    expect(reportRankPlan).toContain("kysely_insights_counts_rank_idx");
    const labelPlan = await planText(
      db,
      sql`select label_ordinal, bucket_start_ms, value
          from private_hot_updater_kysely_insights_report_order
          where job_id = ${report.data.id}
            and order_kind = 'activeBundleSeries' and metric = ''
            and label_key = ${"0".repeat(64)} and label_ordinal >= 0
          order by label_ordinal limit 101`,
    );
    expect(labelPlan).toContain("kysely_insights_order_label_idx");
  }, 180_000);

  it("resumes a populated direct-UUID migration without blocking appends", async () => {
    let db = connect("migration");
    const core = await createKyselyMigrator({
      db,
      provider: "cockroachdb",
    }).migrateToLatest();
    await core.execute();
    await sql`insert into bundle_events (
          id, type, install_id, user_id, username, from_release_id,
          from_bundle_id, to_release_id, to_bundle_id, platform, app_version,
          channel, cohort, update_strategy, fingerprint_hash, sdk_version,
          received_at_ms
        )
        select case when n = 0
            then '00000000-0000-7000-8000-000000000000'::uuid
            else ('019c' || lpad(n::string, 4, '0') ||
              '-0000-7000-8000-' || lpad(n::string, 12, '0'))::uuid end,
          'UPDATE_APPLIED', 'legacy-' || n::string,
          'legacy-user', 'Legacy user',
          '01900000-0000-7000-8000-000000000010'::uuid,
          '01900000-0000-7000-8000-000000000020'::uuid,
          '01900000-0000-7000-8000-000000000011'::uuid,
          '01900000-0000-7000-8000-000000000021'::uuid,
          'ios', '1.0.0', 'production', 'legacy', 'appVersion', null,
          '1.0.0', n::float8 + 1.0
        from generate_series(0, 320) as generated(n)`.execute(db);

    await migrateKyselyInsights(db, "cockroachdb");
    const initial = await sql<{
      readonly ready: unknown;
      readonly migration_after_id: string | null;
      readonly migration_upper_id: string | null;
    }>`select ready, migration_after_id, migration_upper_id
        from private_hot_updater_kysely_insights_state where id = 1`.execute(
      db,
    );
    expect(initial.rows[0]).toMatchObject({
      ready: false,
      migration_after_id: null,
    });
    expect(initial.rows[0]?.migration_upper_id).not.toBeNull();
    await expect(
      prepareKyselyInsightsSource(db, "cockroachdb", 1),
    ).resolves.toEqual({ state: "progress", processed: 1 });

    await disconnect(db);
    db = connect("migration");
    const insights = createKyselyInsightsModel(db, "cockroachdb");
    await insights.append(
      event(
        "019d0000-0000-7000-8000-000000000001",
        "accepted-before-ready",
        500,
      ),
    );
    await insights.append(
      event(
        "00000000-0000-7000-8000-000000000001",
        "accepted-inside-range",
        501,
      ),
    );
    for (;;) {
      const step = await prepareKyselyInsightsSource(db, "cockroachdb", 17);
      if (step.state === "ready") break;
    }
    await insights.append(
      event(
        "019d0000-0000-7000-8000-000000000002",
        "accepted-after-ready",
        502,
      ),
    );
    const counts = await sql<{
      readonly source_count: unknown;
      readonly next_seq: unknown;
    }>`select next_seq,
          (select count(*) from private_hot_updater_kysely_insights_events)
            as source_count
        from private_hot_updater_kysely_insights_state where id = 1`.execute(
      db,
    );
    expect(Number(counts.rows[0]?.source_count)).toBe(324);
    expect(Number(counts.rows[0]?.next_seq)).toBe(324);

    const migrationPlan = await planText(
      db,
      sql`select id from bundle_events
          where id <= ${initial.rows[0]!.migration_upper_id}
            and id > ${"00000000-0000-7000-8000-000000000000"}
          order by id limit 160`,
    );
    expect(migrationPlan).toContain("bundle_events_pkey");
    expect(migrationPlan.toLowerCase()).not.toContain("sort");
  }, 180_000);

  it("records the first legacy poison before materialization", async () => {
    const db = connect("poison");
    const core = await createKyselyMigrator({
      db,
      provider: "cockroachdb",
    }).migrateToLatest();
    await core.execute();
    const poison = event(
      "019a0000-0000-4000-8000-000000000001",
      "legacy-poison",
      1,
    );
    await insertCoreEvent(db, poison);
    await migrateKyselyInsights(db, "cockroachdb");

    await expect(
      prepareKyselyInsightsSource(db, "cockroachdb"),
    ).rejects.toThrow();
    const state = await sql<{
      readonly poison_event_id: string | null;
      readonly source_count: unknown;
      readonly core_count: unknown;
    }>`select poison_event_id,
        (select count(*) from private_hot_updater_kysely_insights_events)
          as source_count,
        (select count(*) from bundle_events) as core_count
      from private_hot_updater_kysely_insights_state where id = 1`.execute(db);
    expect(state.rows[0]).toMatchObject({
      poison_event_id: poison.id,
      source_count: "0",
      core_count: "1",
    });
  }, 180_000);
});
