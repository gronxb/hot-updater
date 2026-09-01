import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  BundleEventRow,
  InsightsReportResult,
} from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createKyselyInsightsModel,
  migrateKyselyInsights,
  prepareKyselyInsightsSource,
  runKyselyInsightsMaintenanceStep,
} from ".";
import { createKyselyMigrator } from "../../../db/fixedMigrator";
import { installationKey } from "./utils";

const databaseUrl = process.env.KYSELY_INSIGHTS_POSTGRES_URL;
const schema = `kysely_insights_${randomUUID().replaceAll("-", "")}`;
const quotedSchema = `"${schema}"`;

let admin: pg.Pool;
let pool: pg.Pool;
let db: Kysely<object>;

type Plan = {
  readonly "Node Type": string;
  readonly "Actual Rows": number;
  readonly "Actual Loops": number;
  readonly "Index Name"?: string;
  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly Plans?: readonly Plan[];
};

const planNodes = (plan: Plan): readonly Plan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(planNodes),
];

const readPlan = async (
  connection: pg.Pool | PoolClient,
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<Plan> => {
  const result = await connection.query<{
    readonly "QUERY PLAN": readonly { readonly Plan: Plan }[];
  }>(`explain (analyze, buffers, format json) ${statement}`, [...parameters]);
  return result.rows[0]!["QUERY PLAN"][0]!.Plan;
};

const expectBoundedIndexPlan = (
  plan: Plan,
  indexName: string,
  rowBound: number,
): void => {
  const nodes = planNodes(plan);
  expect(
    nodes.some((node) => node["Index Name"] === indexName),
    JSON.stringify(plan),
  ).toBe(true);
  for (const node of nodes) {
    expect(node["Node Type"], JSON.stringify(plan)).not.toMatch(
      /Seq Scan|Sort/,
    );
    expect(
      node["Actual Rows"] * node["Actual Loops"],
      JSON.stringify(plan),
    ).toBeLessThanOrEqual(rowBound);
    expect(node["Rows Removed by Filter"] ?? 0, JSON.stringify(plan)).toBe(0);
    expect(
      node["Rows Removed by Index Recheck"] ?? 0,
      JSON.stringify(plan),
    ).toBe(0);
  }
};

const makeId = (family: number, index: number): string =>
  `${(0x01900000 + family).toString(16).padStart(8, "0")}-0000-7000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;

type AppliedEvent = BundleEventRow & { readonly type: "UPDATE_APPLIED" };

const event = (
  id: string,
  installId: string,
  receivedAtMs: number,
  overrides: Partial<AppliedEvent> = {},
): AppliedEvent => ({
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

const reset = async (): Promise<void> => {
  await admin.query(`drop schema if exists ${quotedSchema} cascade`);
  await admin.query(`create schema ${quotedSchema}`);
};

const migrateCore = async (): Promise<void> => {
  const migration = await createKyselyMigrator({
    db,
    provider: "postgresql",
  }).migrateToLatest();
  await migration.execute();
};

const migrateFresh = async (): Promise<void> => {
  await migrateCore();
  await migrateKyselyInsights(db, "postgresql");
};

const maintenance = () =>
  runKyselyInsightsMaintenanceStep(db, "postgresql", {
    maxItems: 160,
    maxRequests: 4_096,
  });

const readyReport = async (
  read: () => Promise<InsightsReportResult>,
): Promise<Extract<InsightsReportResult, { readonly state: "ready" }>> => {
  for (let index = 0; index < 40; index += 1) {
    const result = await read();
    if (result.state === "ready") return result;
    expect(["preparing", "stale"]).toContain(result.state);
    await maintenance();
  }
  throw new Error("Kysely Insights report did not publish.");
};

const insertCoreEvent = async (row: BundleEventRow): Promise<void> => {
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

// Default CI has no evidence database and must not attempt a network read.
describe.skipIf(!databaseUrl)(
  "Kysely Insights PostgreSQL integration",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: databaseUrl });
      await admin.query(`create schema ${quotedSchema}`);
      pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 32,
        options: `-c search_path=${schema}`,
      });
      db = new Kysely<object>({ dialect: new PostgresDialect({ pool }) });
      await pool.query("select current_schema()");
    });

    afterAll(async () => {
      await db?.destroy();
      await admin?.query(`drop schema if exists ${quotedSchema} cascade`);
      await admin?.end();
    });

    it("creates the revision 4 schema and native report indexes", async () => {
      await reset();
      await migrateFresh();

      const state = await pool.query<{
        readonly layout_revision: number;
        readonly ready: boolean;
      }>(`select layout_revision, ready
          from private_hot_updater_kysely_insights_state where id = 1`);
      expect(state.rows[0]).toEqual({ layout_revision: 4, ready: true });

      const columns = await pool.query<{
        readonly table_name: string;
        readonly column_name: string;
        readonly data_type: string;
      }>(
        `select table_name, column_name, data_type
          from information_schema.columns where table_schema = $1 and (
            (table_name = 'private_hot_updater_kysely_insights_report_counts'
              and column_name = 'label_order') or
            (table_name = 'private_hot_updater_kysely_insights_report_jobs'
              and column_name = 'order_after_label') or
            (table_name = 'private_hot_updater_kysely_insights_report_order'
              and column_name in ('label_key', 'label_ordinal',
                'bucket_start_ms')) or
            (table_name =
              'private_hot_updater_kysely_insights_report_page_totals'
              and column_name in ('label', 'label_key'))
          ) order by table_name, column_name`,
        [schema],
      );
      expect(columns.rows).toEqual([
        {
          table_name: "private_hot_updater_kysely_insights_report_counts",
          column_name: "label_order",
          data_type: "bytea",
        },
        {
          table_name: "private_hot_updater_kysely_insights_report_jobs",
          column_name: "order_after_label",
          data_type: "bytea",
        },
        {
          table_name: "private_hot_updater_kysely_insights_report_order",
          column_name: "bucket_start_ms",
          data_type: "bigint",
        },
        {
          table_name: "private_hot_updater_kysely_insights_report_order",
          column_name: "label_key",
          data_type: "character varying",
        },
        {
          table_name: "private_hot_updater_kysely_insights_report_order",
          column_name: "label_ordinal",
          data_type: "bigint",
        },
        {
          table_name: "private_hot_updater_kysely_insights_report_page_totals",
          column_name: "label",
          data_type: "text",
        },
        {
          table_name: "private_hot_updater_kysely_insights_report_page_totals",
          column_name: "label_key",
          data_type: "character varying",
        },
      ]);

      const indexes = await pool.query<{
        readonly indexname: string;
        readonly indexdef: string;
      }>(
        `select indexname, indexdef from pg_indexes
          where schemaname = $1 and indexname in (
            'kysely_insights_alias_source_idx',
            'kysely_insights_counts_order_idx',
            'kysely_insights_counts_rank_idx',
            'kysely_insights_order_label_idx',
            'private_hot_updater_kysely_insights_live_versions_pkey'
          ) order by indexname`,
        [schema],
      );
      expect(indexes.rows).toHaveLength(5);
      expect(
        indexes.rows.find(
          ({ indexname }) => indexname === "kysely_insights_counts_order_idx",
        )?.indexdef,
      ).toContain("bucket_start_ms, label_order");
      expect(
        indexes.rows.find(
          ({ indexname }) => indexname === "kysely_insights_counts_rank_idx",
        )?.indexdef,
      ).toContain("bucket_start_ms, value DESC, label_order");
      expect(
        indexes.rows.find(
          ({ indexname }) => indexname === "kysely_insights_order_label_idx",
        )?.indexdef,
      ).toContain("label_key, label_ordinal");
      expect(
        indexes.rows.find(
          ({ indexname }) =>
            indexname ===
            "private_hot_updater_kysely_insights_live_versions_pkey",
        )?.indexdef,
      ).toContain("install_key, source_seq");
    });

    it("bounds 50,001 event rows and includes late rows behind the cursor", async () => {
      await reset();
      await migrateFresh();
      const key = await installationKey("bulk-install");
      await pool.query(
        `with generated as (
           select i,
             ('019f' || lpad(to_hex(i), 4, '0') ||
               '-0000-7000-8000-' || lpad(to_hex(i), 12, '0')) event_id
           from generate_series(1, 50001) i
         )
         insert into private_hot_updater_kysely_insights_events
           (event_id, source_seq, received_at_ms, install_key, install_id,
             event_type, to_bundle_id, from_bundle_id, raw_json)
         select event_id, i, i, $1, 'bulk-install', 'UPDATE_APPLIED',
           '01900000-0000-7000-8000-000000000021',
           '01900000-0000-7000-8000-000000000020',
           jsonb_build_object(
             'id', event_id, 'type', 'UPDATE_APPLIED',
             'install_id', 'bulk-install', 'user_id', 'bulk-user',
             'username', 'Bulk User',
             'from_release_id',
               '01900000-0000-7000-8000-000000000010',
             'from_bundle_id',
               '01900000-0000-7000-8000-000000000020',
             'to_release_id', '01900000-0000-7000-8000-000000000011',
             'to_bundle_id', '01900000-0000-7000-8000-000000000021',
             'platform', 'ios', 'app_version', '1.0.0',
             'channel', 'production', 'cohort', 'cohort-a',
             'update_strategy', 'appVersion', 'fingerprint_hash', null,
             'sdk_version', '1.0.0', 'received_at_ms', i
           )::text
         from generated`,
        [key],
      );
      await pool.query(`update private_hot_updater_kysely_insights_state
        set next_seq = 50001 where id = 1`);
      await pool.query("analyze private_hot_updater_kysely_insights_events");

      const plan = await readPlan(
        pool,
        `select event_id, source_seq, received_at_ms, install_key, install_id,
           raw_json from private_hot_updater_kysely_insights_events
         where received_at_ms >= 0 and received_at_ms < 1000000
         order by received_at_ms desc, event_id desc limit 101`,
      );
      expectBoundedIndexPlan(plan, "kysely_insights_events_order_idx", 101);

      const insights = createKyselyInsightsModel(db, "postgresql");
      const first = await insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1_000_000,
        limit: 100,
      });
      expect(first.state).toBe("ready");
      if (first.state !== "ready" || first.data.nextCursor === null) return;
      expect(first.data.data).toHaveLength(100);

      await pool.query(
        `with generated as (
           select i,
             ('01ff' || lpad(to_hex(i), 4, '0') ||
               '-0000-7000-8000-' || lpad(to_hex(i), 12, '0')) event_id
           from generate_series(1, 101) i
         )
         insert into private_hot_updater_kysely_insights_events
           (event_id, source_seq, received_at_ms, install_key, install_id,
             event_type, to_bundle_id, from_bundle_id, raw_json)
         select event_id, 50001 + i, 49901, $1, 'bulk-install',
           'UPDATE_APPLIED', '01900000-0000-7000-8000-000000000021',
           '01900000-0000-7000-8000-000000000020',
           jsonb_build_object(
             'id', event_id, 'type', 'UPDATE_APPLIED',
             'install_id', 'bulk-install', 'user_id', 'post-cutoff',
             'username', 'Post cutoff',
             'from_release_id',
               '01900000-0000-7000-8000-000000000010',
             'from_bundle_id',
               '01900000-0000-7000-8000-000000000020',
             'to_release_id', '01900000-0000-7000-8000-000000000011',
             'to_bundle_id', '01900000-0000-7000-8000-000000000021',
             'platform', 'ios', 'app_version', '1.0.0',
             'channel', 'production', 'cohort', 'cohort-a',
             'update_strategy', 'appVersion', 'fingerprint_hash', null,
             'sdk_version', '1.0.0', 'received_at_ms', 49901
           )::text
         from generated`,
        [key],
      );
      await pool.query(`update private_hot_updater_kysely_insights_state
        set next_seq = 50102 where id = 1`);
      const latePage = await insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1_000_000,
        limit: 100,
        cursor: first.data.nextCursor,
      });
      expect(latePage.state).toBe("ready");
      if (latePage.state !== "ready") return;
      expect(latePage.data.data).toHaveLength(100);
      expect(
        latePage.data.data.every(({ user_id }) => user_id === "post-cutoff"),
      ).toBe(true);
      expect(latePage.data.data.map(({ id }) => id)).toEqual(
        Array.from({ length: 100 }, (_, index) => {
          const value = 101 - index;
          return `01ff${value.toString(16).padStart(4, "0")}-0000-7000-8000-${value
            .toString(16)
            .padStart(12, "0")}`;
        }),
      );
      expect(latePage.data.nextCursor).not.toBeNull();
      expect(latePage.versions.sourceGeneration).not.toBe(
        first.versions.sourceGeneration,
      );

      const orderedTail = await insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1_000_000,
        limit: 3,
        cursor: latePage.data.nextCursor!,
      });
      expect(orderedTail.state).toBe("ready");
      if (orderedTail.state !== "ready") return;
      expect(
        orderedTail.data.data.map(({ received_at_ms, user_id }) => ({
          received_at_ms,
          user_id,
        })),
      ).toEqual([
        { received_at_ms: 49_901, user_id: "post-cutoff" },
        { received_at_ms: 49_901, user_id: "bulk-user" },
        { received_at_ms: 49_900, user_id: "bulk-user" },
      ]);
    });

    it("checkpoints an interrupted populated native UUID migration", async () => {
      await reset();
      await migrateCore();
      const idType = await pool.query<{ readonly data_type: string }>(
        `select data_type from information_schema.columns
         where table_schema = $1 and table_name = 'bundle_events'
           and column_name = 'id'`,
        [schema],
      );
      expect(idType.rows[0]?.data_type).toBe("uuid");

      const legacy = Array.from({ length: 41 }, (_, index) =>
        event(makeId(0x400 + index, index + 1), `legacy-${index}`, index + 1),
      );
      for (const row of legacy) await insertCoreEvent(row);
      const upper = legacy.at(-1)!.id;

      const planClient = await pool.connect();
      let plan: Plan;
      try {
        await planClient.query("begin");
        await planClient.query("set local enable_seqscan = off");
        plan = await readPlan(
          planClient,
          `select id from bundle_events where id <= $1
           order by id asc limit 3`,
          [upper],
        );
        await planClient.query("rollback");
      } finally {
        planClient.release();
      }
      expectBoundedIndexPlan(plan, "bundle_events_pkey", 3);

      await migrateKyselyInsights(db, "postgresql");
      const captured = await pool.query<{
        readonly ready: boolean;
        readonly migration_upper_id: string;
        readonly migration_after_id: string | null;
      }>(`select ready, migration_upper_id, migration_after_id
          from private_hot_updater_kysely_insights_state where id = 1`);
      expect(captured.rows[0]).toEqual({
        ready: false,
        migration_upper_id: upper,
        migration_after_id: null,
      });

      const insights = createKyselyInsightsModel(db, "postgresql");
      await insights.append(event(makeId(0x800, 1), "before-step", 100));
      expect(await prepareKyselyInsightsSource(db, "postgresql", 7)).toEqual({
        state: "progress",
        processed: 7,
      });
      const checkpoint = await pool.query<{
        readonly migration_after_id: string;
      }>(`select migration_after_id
          from private_hot_updater_kysely_insights_state where id = 1`);
      const middle = event(makeId(0x410, 999), "during-step", 101);
      expect(middle.id > checkpoint.rows[0]!.migration_after_id).toBe(true);
      expect(middle.id < upper).toBe(true);
      await insights.append(middle);
      for (;;) {
        const step = await prepareKyselyInsightsSource(db, "postgresql", 7);
        if (step.state === "ready") break;
      }
      await insights.append(event(makeId(0x801, 2), "after-ready", 102));

      const final = await pool.query<{
        readonly ready: boolean;
        readonly next_seq: string;
        readonly core_count: number;
        readonly source_count: number;
      }>(`select ready, next_seq,
            (select count(*)::int from bundle_events) core_count,
            (select count(*)::int
              from private_hot_updater_kysely_insights_events) source_count
          from private_hot_updater_kysely_insights_state where id = 1`);
      expect(final.rows[0]).toMatchObject({
        ready: true,
        core_count: 44,
        source_count: 44,
      });
      expect(Number(final.rows[0]!.next_seq)).toBe(44);
    });

    it("preflights and durably records an oversized legacy poison", async () => {
      await reset();
      await migrateCore();
      const poison = event(makeId(0x850, 1), "oversized-postgresql", 1, {
        username: "x".repeat(20_481),
      });
      await insertCoreEvent(poison);
      await migrateKyselyInsights(db, "postgresql");

      await expect(
        prepareKyselyInsightsSource(db, "postgresql"),
      ).rejects.toThrow();
      const state = await pool.query<{
        readonly ready: boolean;
        readonly next_seq: string;
        readonly poison_event_id: string;
        readonly core_count: number;
        readonly source_count: number;
      }>(`select ready, next_seq, poison_event_id,
            (select count(*)::int from bundle_events) core_count,
            (select count(*)::int
              from private_hot_updater_kysely_insights_events) source_count
          from private_hot_updater_kysely_insights_state where id = 1`);
      expect(state.rows[0]).toEqual({
        ready: false,
        next_seq: "0",
        poison_event_id: poison.id,
        core_count: 1,
        source_count: 0,
      });
    });

    it("pins delayed historical search cursor A after publication B", async () => {
      await reset();
      await migrateFresh();
      const insights = createKyselyInsightsModel(db, "postgresql");
      await insights.append(
        event(makeId(0x900, 1), "delayed-a", 200, {
          user_id: "current-user",
        }),
      );
      await insights.append(
        event(makeId(0x901, 2), "delayed-a", 100, {
          user_id: "historical-user",
        }),
      );
      await insights.append(
        event(makeId(0x902, 3), "delayed-b", 150, {
          user_id: "historical-user",
        }),
      );

      const exact = await insights.pageInstallations({
        kind: "installationId",
        installId: "delayed-a",
        limit: 1,
      });
      expect(exact.state).toBe("ready");
      if (exact.state !== "ready") return;
      expect(exact.data.data).toMatchObject([
        {
          install_id: "delayed-a",
          user_id: "current-user",
          received_at_ms: 200,
        },
      ]);

      const pendingA = await insights.pageInstallations({
        kind: "userId",
        userId: "historical-user",
        limit: 1,
      });
      expect(pendingA.state).toBe("preparing");
      await pool.query(`insert into private_hot_updater_kysely_insights_aliases
          (install_key, install_id, alias_kind, alias_hash, value_json,
            normalized_json, source_seq)
        select md5(i::text) || md5('k' || i::text), 'future-' || i,
          'install', md5('a' || i::text) || md5('b' || i::text),
          to_json('future-' || i)::text, to_json('future-' || i)::text,
          100 + i from generate_series(1, 50001) i`);
      await pool.query("analyze private_hot_updater_kysely_insights_aliases");
      const aliasPlan = await readPlan(
        pool,
        `select install_key, install_id, alias_kind, alias_hash, value_json,
           normalized_json, source_seq
         from private_hot_updater_kysely_insights_aliases
         where source_seq <= 3
         order by source_seq, install_key, alias_kind, alias_hash limit 128`,
      );
      expectBoundedIndexPlan(
        aliasPlan,
        "kysely_insights_alias_source_idx",
        128,
      );

      await maintenance();
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
      expect(publicationA.data.total).toMatchObject({
        state: "exact",
        value: 2,
      });
      const publication = publicationA.data.consistency.cutoff.publication;

      await delay(Math.max(0, publication.asOfMs + 2 - Date.now()));
      await insights.append(
        event(makeId(0x903, 4), "delayed-c", 250, {
          user_id: "historical-user",
        }),
      );
      const stale = await insights.pageInstallations({
        kind: "userId",
        userId: "historical-user",
        minAsOfMs: publication.asOfMs + 1,
        limit: 1,
      });
      expect(stale.state).toBe("stale");
      await maintenance();
      const publicationB = await insights.pageInstallations({
        kind: "userId",
        userId: "historical-user",
        minAsOfMs: publication.asOfMs + 1,
        limit: 1,
      });
      expect(publicationB.state).toBe("ready");
      if (publicationB.state !== "ready") return;
      expect(publicationB.data.total).toMatchObject({
        state: "exact",
        value: 3,
      });
      expect(publicationB.data.consistency.cutoff.publication.id).not.toBe(
        publication.id,
      );

      const retainedA = await insights.pageInstallations({
        kind: "userId",
        userId: "historical-user",
        cursor: publicationA.data.nextCursor,
        limit: 1,
      });
      expect(retainedA.state).toBe("ready");
      if (retainedA.state !== "ready") return;
      expect(retainedA.data.consistency.cutoff.publication.id).toBe(
        publication.id,
      );
      expect(retainedA.data.total).toMatchObject({
        state: "exact",
        value: 2,
      });
      expect(
        [...publicationA.data.data, ...retainedA.data.data].find(
          ({ install_id }) => install_id === "delayed-a",
        )?.user_id,
      ).toBe("current-user");
    });

    it("orders Unicode ties and pages zero-filled active bundles", async () => {
      await reset();
      await migrateFresh();
      const insights = createKyselyInsightsModel(db, "postgresql");
      const now = Date.now();
      const firstBundle = "10000000-0000-7000-8000-000000000001";
      const secondBundle = "10000000-0000-7000-8000-000000000002";
      await insights.append(
        event(makeId(0xa00, 1), "series-a", now - 10_800_000, {
          to_bundle_id: firstBundle,
        }),
      );
      await insights.append(
        event(makeId(0xa01, 2), "series-b", now - 10_800_000, {
          to_bundle_id: secondBundle,
        }),
      );
      await insights.append(
        event(makeId(0xa02, 3), "series-a", now - 3_600_000, {
          to_bundle_id: firstBundle,
        }),
      );

      const active = await readyReport(() =>
        insights.getReport({
          query: { kind: "activeOverview", window: "24h" },
        }),
      );
      const first = await insights.pageReport({
        publicationId: active.data.id,
        section: "activeBundleSeries",
        limit: 25,
      });
      expect(first.state).toBe("ready");
      if (
        first.state !== "ready" ||
        first.data.section !== "activeBundleSeries" ||
        first.data.nextCursor === null
      ) {
        return;
      }
      expect(first.data.total).toMatchObject({ state: "exact", value: 48 });
      const second = await insights.pageReport({
        publicationId: active.data.id,
        section: "activeBundleSeries",
        limit: 25,
        cursor: first.data.nextCursor,
      });
      expect(second.state).toBe("ready");
      if (
        second.state !== "ready" ||
        second.data.section !== "activeBundleSeries"
      ) {
        return;
      }
      expect(second.data.nextCursor).toBeNull();
      const observed = [...first.data.data, ...second.data.data];
      expect(observed).toHaveLength(48);
      expect(observed.slice(0, 24).map(({ bundleId }) => bundleId)).toEqual(
        Array(24).fill(firstBundle),
      );
      expect(observed.slice(24).map(({ bundleId }) => bundleId)).toEqual(
        Array(24).fill(secondBundle),
      );
      for (const [bundleId, expectedTotal] of [
        [firstBundle, 2],
        [secondBundle, 1],
      ] as const) {
        const bundleRows = observed.filter((row) => row.bundleId === bundleId);
        expect(bundleRows).toHaveLength(24);
        expect(bundleRows.reduce((sum, row) => sum + row.value, 0)).toBe(
          expectedTotal,
        );
        expect(bundleRows.map((row) => row.bucketStartMs)).toEqual(
          bundleRows.map((row) => row.bucketStartMs).sort((a, b) => a - b),
        );
      }

      const filtered = await insights.pageReport({
        publicationId: active.data.id,
        section: "activeBundleSeries",
        bundleId: firstBundle,
        limit: 100,
      });
      expect(filtered.state).toBe("ready");
      if (
        filtered.state !== "ready" ||
        filtered.data.section !== "activeBundleSeries"
      ) {
        return;
      }
      expect(filtered.data.total).toMatchObject({
        state: "exact",
        value: 24,
      });
      expect(filtered.data.nextCursor).toBeNull();
      expect(filtered.data.data).toHaveLength(24);
      expect(
        filtered.data.data.every((row) => row.bundleId === firstBundle),
      ).toBe(true);
      expect(filtered.data.data.reduce((sum, row) => sum + row.value, 0)).toBe(
        2,
      );
      await expect(
        insights.pageReport({
          publicationId: active.data.id,
          section: "activeBundleSeries",
          bundleId: "10000000-0000-7000-8000-000000000099",
          limit: 10,
        }),
      ).resolves.toMatchObject({
        state: "ready",
        data: { data: [], total: { state: "exact", value: 0 } },
      });
      const filled = await pool.query<{
        readonly rows: number;
        readonly zero_rows: number;
      }>(
        `select count(*)::int rows,
            count(*) filter (where value = 0)::int zero_rows
          from private_hot_updater_kysely_insights_report_order
          where job_id = $1 and order_kind = 'activeBundleSeries'`,
        [active.data.id],
      );
      expect(filled.rows[0]).toEqual({ rows: 48, zero_rows: 45 });

      await pool.query(
        `insert into private_hot_updater_kysely_insights_report_counts
           (job_id, count_key, section, metric, label, label_order,
             bucket_start_ms, value)
         select $1, md5(i::text) || md5('rank' || i::text),
           'activeBundleTotals', '', 'noise-' || i,
           decode(md5(i::text), 'hex'), -1, i
         from generate_series(1, 20000) i on conflict do nothing`,
        [active.data.id],
      );
      await pool.query(
        "analyze private_hot_updater_kysely_insights_report_counts",
      );
      const rankPlan = await readPlan(
        pool,
        `select label, value
         from private_hot_updater_kysely_insights_report_counts
         where job_id = $1 and section = 'activeBundleTotals'
           and metric = '' and bucket_start_ms = -1
         order by value desc, label_order limit 160`,
        [active.data.id],
      );
      expectBoundedIndexPlan(rankPlan, "kysely_insights_counts_rank_idx", 160);

      const labels = ["😀", "é", "Z", "a", "e\u0301", "Å", "東京"];
      for (const [index, cohort] of labels.entries()) {
        await insights.append(
          event(
            makeId(0xa10 + index, index + 10),
            `order-${index}`,
            now + index,
            { cohort },
          ),
        );
      }
      const detail = await readyReport(() =>
        insights.getReport({
          query: {
            kind: "bundleDetail",
            bundleId: "01900000-0000-7000-8000-000000000021",
            window: "all",
          },
        }),
      );
      const cohorts = await insights.pageReport({
        publicationId: detail.data.id,
        section: "movementCohorts",
        metric: "installed",
        limit: 10,
      });
      expect(cohorts.state).toBe("ready");
      if (cohorts.state !== "ready") return;
      expect(
        cohorts.data.data.map((row) => Reflect.get(row, "cohort")),
      ).toEqual([...labels].sort());

      await pool.query(
        `insert into private_hot_updater_kysely_insights_report_counts
           (job_id, count_key, section, metric, label, label_order,
             bucket_start_ms, value)
         select $1, md5(i::text) || md5('noise' || i::text),
           'movementCohorts', 'installed', 'noise-' || i,
           decode(md5(i::text), 'hex'), -1, 1
         from generate_series(1, 20000) i on conflict do nothing`,
        [detail.data.id],
      );
      await pool.query(
        "analyze private_hot_updater_kysely_insights_report_counts",
      );
      const orderPlan = await readPlan(
        pool,
        `select label, value
         from private_hot_updater_kysely_insights_report_counts
         where job_id = $1 and section = 'movementCohorts'
           and metric = 'installed' and bucket_start_ms = -1
         order by label_order limit 160`,
        [detail.data.id],
      );
      expectBoundedIndexPlan(
        orderPlan,
        "kysely_insights_counts_order_idx",
        160,
      );

      await pool.query(
        `insert into private_hot_updater_kysely_insights_report_order
           (job_id, order_kind, metric, ordinal, label, label_key,
             label_ordinal, bucket_start_ms, value)
         select $1, 'activeBundleSeries', '', 1000 + i, 'noise-' || i,
           md5(i::text) || md5('label' || i::text), i, i, 1
         from generate_series(1, 20000) i on conflict do nothing`,
        [active.data.id],
      );
      await pool.query(
        "analyze private_hot_updater_kysely_insights_report_order",
      );
      const firstBundleKey = createHash("sha256")
        .update(JSON.stringify(firstBundle))
        .digest("hex");
      const filteredPlan = await readPlan(
        pool,
        `select label_ordinal, bucket_start_ms, value
         from private_hot_updater_kysely_insights_report_order
         where job_id = $1 and order_kind = 'activeBundleSeries'
           and metric = '' and label_key = $2 and label_ordinal >= 0
         order by label_ordinal limit 101`,
        [active.data.id, firstBundleKey],
      );
      expectBoundedIndexPlan(
        filteredPlan,
        "kysely_insights_order_label_idx",
        101,
      );
    });

    it("rolls back one rejected allocation across concurrent appends", async () => {
      await reset();
      await migrateFresh();
      const rejected = event(makeId(0xb00, 1), "rejected", 1);
      await pool.query(`create function reject_kysely_event()
        returns trigger as $$ begin
          if new.event_id = '${rejected.id}' then
            raise exception 'forced rejection';
          end if;
          return new;
        end $$ language plpgsql`);
      await pool.query(`create trigger reject_kysely_event before insert
        on private_hot_updater_kysely_insights_events
        for each row execute function reject_kysely_event()`);

      const insights = createKyselyInsightsModel(db, "postgresql");
      const accepted = Array.from({ length: 20 }, (_, index) =>
        event(
          makeId(0xb10 + index, index + 2),
          `concurrent-${index}`,
          index + 2,
        ),
      );
      const writes = await Promise.allSettled([
        insights.append(rejected),
        ...accepted.map((row) => insights.append(row)),
      ]);
      expect(writes.filter(({ status }) => status === "rejected")).toHaveLength(
        1,
      );

      const state = await pool.query<{
        readonly next_seq: string;
        readonly core_count: number;
        readonly source_count: number;
      }>(`select next_seq,
            (select count(*)::int from bundle_events) core_count,
            (select count(*)::int
              from private_hot_updater_kysely_insights_events) source_count
          from private_hot_updater_kysely_insights_state where id = 1`);
      expect(Number(state.rows[0]!.next_seq)).toBe(20);
      expect(state.rows[0]).toMatchObject({
        core_count: 20,
        source_count: 20,
      });
      const sequences = await pool.query<{ readonly source_seq: string }>(
        `select source_seq
         from private_hot_updater_kysely_insights_events
         order by source_seq`,
      );
      expect(
        sequences.rows.map(({ source_seq }) => Number(source_seq)),
      ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

      await pool.query(`drop trigger reject_kysely_event
        on private_hot_updater_kysely_insights_events`);
      await insights.append(rejected);
      const retried = await pool.query<{ readonly source_seq: string }>(
        `select source_seq
         from private_hot_updater_kysely_insights_events where event_id = $1`,
        [rejected.id],
      );
      expect(Number(retried.rows[0]?.source_seq)).toBe(21);
    });

    it("fences duplicate workers without blocking an append", async () => {
      await reset();
      await migrateFresh();
      const insights = createKyselyInsightsModel(db, "postgresql");
      await insights.append(
        event(makeId(0xc00, 1), "locked-search", 1, {
          username: "Lock Target",
        }),
      );
      const pending = await insights.pageInstallations({
        kind: "contains",
        query: "lock target",
        limit: 10,
      });
      expect(pending.state).toBe("preparing");
      if (pending.state !== "preparing") return;

      const holder = await pool.connect();
      let firstStep: ReturnType<typeof maintenance> | undefined;
      let secondStep: ReturnType<typeof maintenance> | undefined;
      let append: Promise<void> | undefined;
      let appendCompleted = false;
      try {
        await holder.query("begin");
        await holder.query(
          `select id from private_hot_updater_kysely_insights_search_jobs
           where id = $1 for update`,
          [pending.job.id],
        );
        firstStep = maintenance();
        secondStep = maintenance();

        let blocked = 0;
        for (let index = 0; index < 40; index += 1) {
          const waits = await pool.query<{ readonly count: number }>(
            `select count(*)::int count from pg_stat_activity
             where datname = current_database() and pid <> pg_backend_pid()
               and wait_event_type = 'Lock'
               and query like
                 '%private_hot_updater_kysely_insights_search_jobs%'`,
          );
          blocked = waits.rows[0]?.count ?? 0;
          if (blocked >= 1) break;
          await delay(25);
        }
        expect(blocked).toBeGreaterThanOrEqual(1);

        append = insights
          .append(event(makeId(0xc01, 2), "append-during-job-lock", 2))
          .then(() => {
            appendCompleted = true;
          });
        await Promise.race([append, delay(1_500)]);
        expect(appendCompleted).toBe(true);
        const state = await pool.query<{ readonly next_seq: string }>(
          `select next_seq from private_hot_updater_kysely_insights_state
           where id = 1`,
        );
        expect(Number(state.rows[0]?.next_seq)).toBe(2);
        await holder.query("commit");
      } finally {
        if (!appendCompleted) await holder.query("rollback");
        holder.release();
      }

      await append;
      const results = await Promise.all([firstStep!, secondStep!]);
      expect(results.map(({ state }) => state)).toEqual([
        "published",
        "published",
      ]);
      const processed = results
        .map((result) => result.processed)
        .sort((left, right) => left - right);
      expect(processed[0]).toBe(0);
      expect(processed[1]).toBeGreaterThan(0);
      const ready = await insights.pageInstallations({
        kind: "contains",
        query: "lock target",
        limit: 10,
      });
      expect(ready.state).toBe("ready");
      if (ready.state !== "ready") return;
      expect(ready.data.data).toMatchObject([{ install_id: "locked-search" }]);
      const job = await pool.query<{
        readonly state: string;
        readonly total: string;
        readonly row_count: number;
      }>(
        `select state, total,
            (select count(*)::int
              from private_hot_updater_kysely_insights_search_rows
              where job_id = $1) row_count
          from private_hot_updater_kysely_insights_search_jobs where id = $1`,
        [pending.job.id],
      );
      expect(job.rows[0]).toMatchObject({
        state: "ready",
        row_count: 1,
      });
      expect(Number(job.rows[0]?.total)).toBe(1);
    });
  },
);
