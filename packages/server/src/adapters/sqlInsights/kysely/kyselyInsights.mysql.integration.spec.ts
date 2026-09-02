import { createHash, randomUUID } from "node:crypto";

import type {
  BundleEventRow,
  InsightsReportResult,
} from "@hot-updater/plugin-core";
import { Kysely, MysqlDialect } from "kysely";
import mysql, { type Pool, type RowDataPacket } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createKyselyInsightsModel,
  migrateKyselyInsights,
  prepareKyselyInsightsSource,
  runKyselyInsightsMaintenanceStep,
} from ".";
import { createKyselyMigrator } from "../../../db/fixedMigrator";
import { kyselyAdapter } from "../../kysely";

const mysqlUrl = process.env.KYSELY_INSIGHTS_MYSQL_URL;
const databaseNamespace = "20000000-0000-4000-8000-000000000001";
const describeMySQL = mysqlUrl ? describe : describe.skip;

type AppliedEvent = BundleEventRow & { readonly type: "UPDATE_APPLIED" };

type TestConnection = {
  readonly db: Kysely<object>;
  readonly pool: Pool;
  readonly close: () => Promise<void>;
};

type DatabaseHarness = {
  readonly connect: () => TestConnection;
};

const fixtureInstallationKey = (installId: string): string =>
  createHash("sha256").update(JSON.stringify(installId)).digest("hex");

const fixtureLabelKey = (label: string): string =>
  createHash("sha256").update(JSON.stringify(label)).digest("hex");

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

const mysqlUuid = (namespace: string, index: number): string =>
  `${namespace}${index.toString(16).padStart(8 - namespace.length, "0")}-0000-7000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;

const rows = async <T extends RowDataPacket>(
  pool: Pool,
  statement: string,
  values: readonly unknown[] = [],
): Promise<T[]> => {
  const [result] = await pool.promise().query<T[]>(statement, [...values]);
  return result;
};

const scalar = async (
  pool: Pool,
  statement: string,
  values: readonly unknown[] = [],
): Promise<number> => {
  const result = await rows<RowDataPacket>(pool, statement, values);
  return Number(result[0]?.value);
};

const explainJson = async (
  pool: Pool,
  statement: string,
  values: readonly unknown[] = [],
): Promise<string> => {
  const result = await rows<RowDataPacket>(
    pool,
    `explain format=json ${statement}`,
    values,
  );
  return String(result[0]?.EXPLAIN);
};

const insertRows = async (
  pool: Pool,
  table: string,
  values: readonly Readonly<Record<string, unknown>>[],
  chunkSize = 320,
): Promise<void> => {
  if (values.length === 0) return;
  const columns = Object.keys(values[0]!);
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  for (let start = 0; start < values.length; start += chunkSize) {
    const chunk = values.slice(start, start + chunkSize);
    await pool.promise().query(
      `insert into ${table} (${columns.join(", ")}) values ${chunk
        .map(() => placeholders)
        .join(", ")}`,
      chunk.flatMap((row) => columns.map((column) => row[column])),
    );
  }
};

const migrateAll = async (db: Kysely<object>): Promise<void> => {
  const migration = await kyselyAdapter({
    db,
    provider: "mysql",
    insightsDatabaseNamespace: databaseNamespace,
  }).createMigrator!().migrateToLatest();
  await migration.execute();
};

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
  throw new Error("report did not publish");
};

describeMySQL(
  "Kysely Insights MySQL integration (set KYSELY_INSIGHTS_MYSQL_URL)",
  { timeout: 300_000 },
  () => {
    let adminPool: Pool;
    const activeDatabases = new Set<string>();

    beforeAll(() => {
      const adminUrl = new URL(mysqlUrl!);
      adminUrl.pathname = "/";
      adminPool = mysql.createPool(adminUrl.toString());
    });

    afterAll(async () => {
      for (const databaseName of activeDatabases) {
        await adminPool
          .promise()
          .query(`drop database if exists \`${databaseName}\``);
      }
      await adminPool.promise().end();
    });

    const withDatabase = async (
      run: (harness: DatabaseHarness) => Promise<void>,
    ): Promise<void> => {
      const databaseName = `hot_updater_kysely_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 12)}`;
      activeDatabases.add(databaseName);
      await adminPool
        .promise()
        .query(
          `create database \`${databaseName}\` character set utf8mb4 collate utf8mb4_bin`,
        );
      const databaseUrl = new URL(mysqlUrl!);
      databaseUrl.pathname = `/${databaseName}`;
      const connections = new Set<TestConnection>();
      const harness: DatabaseHarness = {
        connect: () => {
          const pool = mysql.createPool(databaseUrl.toString());
          const db = new Kysely<object>({
            dialect: new MysqlDialect({ pool }),
          });
          const connection: TestConnection = {
            db,
            pool,
            close: async () => {
              if (!connections.delete(connection)) return;
              await db.destroy();
            },
          };
          connections.add(connection);
          return connection;
        },
      };
      try {
        await run(harness);
      } finally {
        await Promise.all([...connections].map(({ close }) => close()));
        await adminPool
          .promise()
          .query(`drop database if exists \`${databaseName}\``);
        activeDatabases.delete(databaseName);
      }
    };

    it("creates rev4 DDL and bounds a 50,001-row native event page", async () => {
      await withDatabase(async ({ connect }) => {
        const { db, pool } = connect();
        await migrateAll(db);

        expect(
          await rows<RowDataPacket>(
            pool,
            `select layout_revision from
              private_hot_updater_kysely_insights_state where id = 1`,
          ),
        ).toMatchObject([{ layout_revision: 4 }]);
        const columns = await rows<RowDataPacket>(
          pool,
          `select table_name as tableName, column_name as columnName,
              data_type as dataType, collation_name as collationName
            from information_schema.columns
            where table_schema = database() and (
              (table_name = 'private_hot_updater_kysely_insights_report_counts'
                and column_name = 'label_order') or
              (table_name = 'private_hot_updater_kysely_insights_report_jobs'
                and column_name = 'order_after_label') or
              (table_name = 'private_hot_updater_kysely_insights_aliases'
                and column_name = 'install_id'))
            order by table_name, column_name`,
        );
        expect(columns).toMatchObject([
          { columnName: "install_id", collationName: "utf8mb4_bin" },
          { columnName: "label_order", dataType: "varbinary" },
          { columnName: "order_after_label", dataType: "varbinary" },
        ]);

        const indexes = await rows<RowDataPacket>(
          pool,
          `select table_name as tableName, index_name as indexName,
              group_concat(concat(column_name,
                if(collation = 'D', ' desc', ''))
                order by seq_in_index) as columnsInOrder
            from information_schema.statistics
            where table_schema = database() and index_name in (
              'PRIMARY', 'kysely_insights_alias_source_idx',
              'kysely_insights_counts_order_idx',
              'kysely_insights_counts_rank_idx',
              'kysely_insights_order_label_idx')
              and table_name in (
                'private_hot_updater_kysely_insights_live_versions',
                'private_hot_updater_kysely_insights_aliases',
                'private_hot_updater_kysely_insights_report_counts',
                'private_hot_updater_kysely_insights_report_order',
                'private_hot_updater_kysely_insights_report_page_totals')
            group by table_name, index_name`,
        );
        expect(indexes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              tableName: "private_hot_updater_kysely_insights_live_versions",
              indexName: "PRIMARY",
              columnsInOrder: "install_key,source_seq",
            }),
            expect.objectContaining({
              indexName: "kysely_insights_alias_source_idx",
              columnsInOrder: "source_seq,install_key,alias_kind,alias_hash",
            }),
            expect.objectContaining({
              indexName: "kysely_insights_counts_order_idx",
              columnsInOrder:
                "job_id,section,metric,bucket_start_ms,label_order",
            }),
            expect.objectContaining({
              indexName: "kysely_insights_counts_rank_idx",
              columnsInOrder:
                "job_id,section,metric,bucket_start_ms,value desc,label_order",
            }),
            expect.objectContaining({
              indexName: "kysely_insights_order_label_idx",
              columnsInOrder:
                "job_id,order_kind,metric,label_key,label_ordinal",
            }),
            expect.objectContaining({
              tableName:
                "private_hot_updater_kysely_insights_report_page_totals",
              indexName: "PRIMARY",
              columnsInOrder: "job_id,section,metric,label_key",
            }),
          ]),
        );

        const stored = Array.from({ length: 50_001 }, (_, offset) => {
          const index = offset + 1;
          const id = mysqlUuid("01c1", index);
          const raw = event(id, `large-mysql-${index}`, index);
          return {
            event_id: id,
            source_seq: index,
            received_at_ms: index,
            install_key: fixtureInstallationKey(raw.install_id),
            install_id: raw.install_id,
            event_type: raw.type,
            to_bundle_id: raw.to_bundle_id,
            from_bundle_id: raw.from_bundle_id,
            raw_json: JSON.stringify(raw),
          };
        });
        await insertRows(
          pool,
          "private_hot_updater_kysely_insights_events",
          stored,
          500,
        );
        await pool.promise().query(
          `update private_hot_updater_kysely_insights_state
              set next_seq = 50001 where id = 1`,
        );

        const page = await createKyselyInsightsModel(
          db,
          "mysql",
          databaseNamespace,
        ).pageEvents({
          selector: { kind: "all" },
          beforeReceivedAtMs: 60_000,
          limit: 100,
        });
        expect(page.state).toBe("ready");
        if (page.state !== "ready") return;
        expect(page.data.data).toHaveLength(100);
        expect(page.data.hasNext).toBe(true);

        const lateEvent = event(
          "01c1fffe-0000-7000-8000-00000000fffe",
          "late-behind-mysql-cursor",
          49_850,
        );
        await createKyselyInsightsModel(db, "mysql", databaseNamespace).append(
          lateEvent,
        );
        const continuation = await createKyselyInsightsModel(
          db,
          "mysql",
          databaseNamespace,
        ).pageEvents({
          selector: { kind: "all" },
          beforeReceivedAtMs: 60_000,
          limit: 100,
          cursor: page.data.nextCursor!,
        });
        expect(continuation.state).toBe("ready");
        if (continuation.state !== "ready") return;
        expect(continuation.data.data).toContainEqual(lateEvent);
        expect(
          new Set(
            [...page.data.data, ...continuation.data.data].map(({ id }) => id),
          ).size,
        ).toBe(page.data.data.length + continuation.data.data.length);
        expect(continuation.data.data).toEqual(
          [...continuation.data.data].sort(
            (left, right) =>
              right.received_at_ms - left.received_at_ms ||
              (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
          ),
        );

        const sourceStatement = `select event_id, source_seq, received_at_ms,
            install_key, install_id, raw_json
          from private_hot_updater_kysely_insights_events
          where 1 = 1 and received_at_ms >= 0 and received_at_ms < 60000
          order by received_at_ms desc, event_id desc limit 101`;
        const plan = await explainJson(pool, sourceStatement);
        expect(plan).toContain("kysely_insights_events_order_idx");
        expect(plan).not.toContain('"using_filesort": true');
        const analyzed = await rows<RowDataPacket>(
          pool,
          `explain analyze ${sourceStatement}`,
        );
        const analyzedText = analyzed.map((row) => row.EXPLAIN).join("\n");
        expect(analyzedText).toContain("kysely_insights_events_order_idx");
        expect(analyzedText).toMatch(/actual time=.* rows=101 loops=1/);
      });
    }, 300_000);

    it("uses all four exact-state work indexes without a filesort", async () => {
      await withDatabase(async ({ connect }) => {
        const { db, pool } = connect();
        await migrateAll(db);
        const insights = createKyselyInsightsModel(
          db,
          "mysql",
          databaseNamespace,
        );
        await insights.append(
          event("01c20000-0000-7000-8000-000000000001", "work-plan", 1),
        );
        const search = await insights.pageInstallations({
          kind: "contains",
          query: "work-plan",
          limit: 10,
        });
        const report = await insights.getReport({
          query: { kind: "installationOverview" },
        });
        expect(search.state).toBe("preparing");
        expect(report.state).toBe("preparing");

        const searchSeed = (
          await rows<RowDataPacket>(
            pool,
            `select * from private_hot_updater_kysely_insights_search_jobs
              limit 1`,
          )
        )[0]!;
        const reportSeed = (
          await rows<RowDataPacket>(
            pool,
            `select * from private_hot_updater_kysely_insights_report_jobs
              limit 1`,
          )
        )[0]!;
        await insertRows(
          pool,
          "private_hot_updater_kysely_insights_search_jobs",
          Array.from({ length: 502 }, (_, index) => ({
            ...searchSeed,
            id: mysqlUuid("01c3", index + 1),
            state:
              index === 500 ? "queued" : index === 501 ? "preparing" : "ready",
          })),
        );
        await insertRows(
          pool,
          "private_hot_updater_kysely_insights_report_jobs",
          Array.from({ length: 502 }, (_, index) => ({
            ...reportSeed,
            id: mysqlUuid("01c4", index + 1),
            state:
              index === 500 ? "queued" : index === 501 ? "preparing" : "ready",
          })),
        );
        await pool.promise().query(
          `analyze table private_hot_updater_kysely_insights_search_jobs,
              private_hot_updater_kysely_insights_report_jobs`,
        );

        for (const [table, indexName] of [
          [
            "private_hot_updater_kysely_insights_search_jobs",
            "kysely_insights_search_work_idx",
          ],
          [
            "private_hot_updater_kysely_insights_report_jobs",
            "kysely_insights_report_work_idx",
          ],
        ] as const) {
          for (const state of ["queued", "preparing"] as const) {
            const plan = await explainJson(
              pool,
              `select id, as_of_ms from ${table}
                where state = ? order by as_of_ms, id limit 1`,
              [state],
            );
            expect(plan).toContain(indexName);
            expect(plan).not.toContain('"using_filesort": true');
          }
        }
      });
    });

    it("resumes an interrupted populated migration around live appends", async () => {
      await withDatabase(async ({ connect }) => {
        const first = connect();
        const core = await createKyselyMigrator({
          db: first.db,
          provider: "mysql",
        }).migrateToLatest();
        await core.execute();
        const legacy = [
          event("00000000-0000-7000-8000-000000000000", "sentinel-install", 1),
          ...Array.from({ length: 320 }, (_, index) =>
            event(mysqlUuid("01c5", index), `legacy-mysql-${index}`, index + 2),
          ),
        ];
        await insertRows(first.pool, "bundle_events", legacy);
        await migrateKyselyInsights(first.db, "mysql", databaseNamespace);

        expect(
          await prepareKyselyInsightsSource(
            first.db,
            "mysql",
            databaseNamespace,
            1,
          ),
        ).toEqual({ state: "progress", processed: 1 });
        expect(
          await rows<RowDataPacket>(
            first.pool,
            `select migration_after_id from
              private_hot_updater_kysely_insights_state where id = 1`,
          ),
        ).toMatchObject([
          { migration_after_id: "00000000-0000-7000-8000-000000000000" },
        ]);
        await first.close();

        const second = connect();
        const insights = createKyselyInsightsModel(
          second.db,
          "mysql",
          databaseNamespace,
        );
        await insights.append(
          event(
            "01d00000-0000-7000-8000-000000000001",
            "accepted-before-ready",
            500,
          ),
        );
        await insights.append(
          event(
            "00000000-0000-7000-8000-000000000001",
            "accepted-inside-captured-range",
            501,
          ),
        );
        for (;;) {
          const step = await prepareKyselyInsightsSource(
            second.db,
            "mysql",
            databaseNamespace,
            17,
          );
          if (step.state === "ready") break;
        }
        await insights.append(
          event(
            "01d00000-0000-7000-8000-000000000002",
            "accepted-after-ready",
            502,
          ),
        );

        expect(
          await rows<RowDataPacket>(
            second.pool,
            `select ready, next_seq, migration_upper_id,
                (select count(*) from bundle_events) as core_count,
                (select count(*) from
                  private_hot_updater_kysely_insights_events) as source_count
              from private_hot_updater_kysely_insights_state where id = 1`,
          ),
        ).toMatchObject([
          {
            ready: 1,
            next_seq: legacy.length + 3,
            core_count: legacy.length + 3,
            source_count: legacy.length + 3,
          },
        ]);
      });
    });

    it("preflights and durably records an oversized legacy poison", async () => {
      await withDatabase(async ({ connect }) => {
        const { db, pool } = connect();
        const core = await createKyselyMigrator({
          db,
          provider: "mysql",
        }).migrateToLatest();
        await core.execute();
        const poison = event(
          "01d10000-0000-7000-8000-000000000001",
          "oversized-mysql",
          1,
          { username: "x".repeat(20_481) },
        );
        await insertRows(pool, "bundle_events", [poison]);
        await migrateKyselyInsights(db, "mysql", databaseNamespace);

        await expect(
          prepareKyselyInsightsSource(db, "mysql", databaseNamespace),
        ).rejects.toThrow();
        expect(
          await rows<RowDataPacket>(
            pool,
            `select ready, next_seq, poison_event_id,
                (select count(*) from bundle_events) as core_count,
                (select count(*) from
                  private_hot_updater_kysely_insights_events) as source_count
              from private_hot_updater_kysely_insights_state where id = 1`,
          ),
        ).toMatchObject([
          {
            ready: 0,
            next_seq: 0,
            poison_event_id: poison.id,
            core_count: 1,
            source_count: 0,
          },
        ]);
        const plan = await explainJson(
          pool,
          `select id from bundle_events where id <= ? order by id limit 160`,
          [poison.id],
        );
        expect(plan).toContain("PRIMARY");
        expect(plan).not.toContain('"using_filesort": true');
      });
    });

    it("keeps native publication, zero-fill, and order plans exact", async () => {
      await withDatabase(async ({ connect }) => {
        const { db, pool } = connect();
        await migrateAll(db);
        const insights = createKyselyInsightsModel(
          db,
          "mysql",
          databaseNamespace,
        );
        const advance = () =>
          runKyselyInsightsMaintenanceStep(db, "mysql", databaseNamespace, {
            maxItems: 160,
            maxRequests: 4_096,
          });

        await insights.append(
          event("01d20000-0000-7000-8000-000000000001", "delayed-a", 200, {
            user_id: "current-user",
          }),
        );
        await insights.append(
          event("01d20000-0000-7000-8000-000000000002", "delayed-a", 100, {
            user_id: "historical-user",
          }),
        );
        await insights.append(
          event("01d20000-0000-7000-8000-000000000003", "delayed-b", 150, {
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
        await expect(
          insights.pageInstallations({
            kind: "userId",
            userId: "historical-user",
            limit: 1,
          }),
        ).resolves.toMatchObject({ state: "preparing" });
        await advance();
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
        expect(publicationA.data.total).toMatchObject({ value: 2 });

        const now = Date.now();
        const firstBundle = "10000000-0000-7000-8000-000000000001";
        const secondBundle = "10000000-0000-7000-8000-000000000002";
        const labels = ["😀", "é", "Z", "a"];
        for (const [index, cohort] of labels.entries()) {
          await insights.append(
            event(
              mysqlUuid("01d3", index + 1),
              `unicode-${index}`,
              now - 172_800_000,
              { cohort, to_bundle_id: firstBundle },
            ),
          );
        }
        const detail = await readyReport(
          () =>
            insights.getReport({
              query: {
                kind: "bundleDetail",
                bundleId: firstBundle,
                window: "all",
              },
            }),
          advance,
        );
        await expect(
          insights.pageReport({
            publicationId: detail.data.id,
            section: "movementCohorts",
            metric: "installed",
            limit: 10,
          }),
        ).resolves.toMatchObject({
          state: "ready",
          data: {
            data: [...labels].sort().map((cohort) => ({ cohort, value: 1 })),
          },
        });
        const labelPlan = await explainJson(
          pool,
          `select label, value
            from private_hot_updater_kysely_insights_report_counts
            where job_id = ? and section = 'movementCohorts'
              and metric = 'installed' and bucket_start_ms = -1
            order by label_order limit 160`,
          [detail.data.id],
        );
        expect(labelPlan).toContain("kysely_insights_counts_order_idx");
        expect(labelPlan).not.toContain('"using_filesort": true');

        await insights.append(
          event(mysqlUuid("01d4", 1), "series-a", now - 10_800_000, {
            to_bundle_id: firstBundle,
          }),
        );
        await insights.append(
          event(mysqlUuid("01d4", 2), "series-b", now - 10_800_000, {
            to_bundle_id: secondBundle,
          }),
        );
        await insights.append(
          event(mysqlUuid("01d4", 3), "series-a", now - 3_600_000, {
            to_bundle_id: firstBundle,
          }),
        );
        const active = await readyReport(
          () =>
            insights.getReport({
              query: { kind: "activeOverview", window: "24h" },
            }),
          advance,
        );
        const series = await insights.pageReport({
          publicationId: active.data.id,
          section: "activeBundleSeries",
          limit: 100,
        });
        expect(series.state).toBe("ready");
        if (
          series.state !== "ready" ||
          series.data.section !== "activeBundleSeries"
        ) {
          return;
        }
        expect(series.data.data).toHaveLength(48);
        expect(
          series.data.data.filter(({ value }) => value === 0),
        ).toHaveLength(45);

        const rankPlan = await explainJson(
          pool,
          `select label, value
            from private_hot_updater_kysely_insights_report_counts
            where job_id = ? and section = 'activeBundleTotals'
              and metric = '' and bucket_start_ms = -1
            order by value desc, label_order limit 160`,
          [active.data.id],
        );
        expect(rankPlan).toContain("kysely_insights_counts_rank_idx");
        expect(rankPlan).not.toContain('"using_filesort": true');

        const globalPlan = await explainJson(
          pool,
          `select ordinal, label, label_ordinal, bucket_start_ms, value
            from private_hot_updater_kysely_insights_report_order
              force index (primary)
            where job_id = ? and order_kind = 'activeBundleSeries'
              and metric = '' and ordinal >= 0
            order by ordinal limit 101`,
          [active.data.id],
        );
        expect(globalPlan).toContain("PRIMARY");
        expect(globalPlan).not.toContain('"using_filesort": true');
        const filteredPlan = await explainJson(
          pool,
          `select ordinal, label, label_ordinal, bucket_start_ms, value
            from private_hot_updater_kysely_insights_report_order
            where job_id = ? and order_kind = 'activeBundleSeries'
              and metric = '' and label_key = ? and label_ordinal >= 0
            order by label_ordinal limit 101`,
          [active.data.id, fixtureLabelKey(firstBundle)],
        );
        expect(filteredPlan).toContain("kysely_insights_order_label_idx");
        expect(filteredPlan).not.toContain('"using_filesort": true');
      });
    });

    it("rolls back a failed concurrent append and fences workers", async () => {
      await withDatabase(async ({ connect }) => {
        const { db, pool } = connect();
        await migrateAll(db);
        const rejected = event(
          "01d50000-0000-7000-8000-000000000001",
          "rollback-mysql",
          1,
        );
        await pool.promise().query(`create trigger reject_kysely_insights_event
          before insert on private_hot_updater_kysely_insights_events
          for each row begin
            if new.event_id = '${rejected.id}' then
              signal sqlstate '45000' set message_text = 'forced';
            end if;
          end`);
        const insights = createKyselyInsightsModel(
          db,
          "mysql",
          databaseNamespace,
        );
        const accepted = Array.from({ length: 20 }, (_, index) =>
          event(
            mysqlUuid("01d6", index + 1),
            `concurrent-mysql-${index}`,
            index + 2,
          ),
        );
        const writes = await Promise.allSettled([
          insights.append(rejected),
          ...accepted.map((row) => insights.append(row)),
        ]);
        expect(
          writes.filter(({ status }) => status === "rejected"),
        ).toHaveLength(1);
        expect(
          await rows<RowDataPacket>(
            pool,
            `select next_seq,
                (select count(*) from bundle_events) as core_count,
                (select count(*) from
                  private_hot_updater_kysely_insights_events) as source_count
              from private_hot_updater_kysely_insights_state where id = 1`,
          ),
        ).toMatchObject([{ next_seq: 20, core_count: 20, source_count: 20 }]);
        expect(
          await scalar(
            pool,
            "select count(*) as value from bundle_events where id = ?",
            [rejected.id],
          ),
        ).toBe(0);
        expect(
          (
            await rows<RowDataPacket>(
              pool,
              `select source_seq from
                private_hot_updater_kysely_insights_events order by source_seq`,
            )
          ).map((row) => Number(row.source_seq)),
        ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
        await pool.promise().query("drop trigger reject_kysely_insights_event");
        await insights.append(rejected);
        expect(
          await rows<RowDataPacket>(
            pool,
            `select source_seq from
              private_hot_updater_kysely_insights_events where event_id = ?`,
            [rejected.id],
          ),
        ).toMatchObject([{ source_seq: 21 }]);

        const pending = await insights.pageInstallations({
          kind: "contains",
          query: "concurrent-mysql",
          limit: 10,
        });
        expect(pending.state).toBe("preparing");
        const concurrentSteps = await Promise.all([
          runKyselyInsightsMaintenanceStep(db, "mysql", databaseNamespace, {
            maxItems: 160,
            maxRequests: 4_096,
          }),
          runKyselyInsightsMaintenanceStep(db, "mysql", databaseNamespace, {
            maxItems: 160,
            maxRequests: 4_096,
          }),
        ]);
        const processed = concurrentSteps
          .map((step) => step.processed)
          .sort((left, right) => left - right);
        expect(processed[0]).toBe(0);
        expect(processed[1]).toBeGreaterThan(0);
        if (pending.state === "preparing") {
          expect(concurrentSteps.map(({ jobId }) => jobId)).toEqual([
            pending.job.id,
            pending.job.id,
          ]);
        }
        const published = await insights.pageInstallations({
          kind: "contains",
          query: "concurrent-mysql",
          limit: 100,
        });
        expect(published).toMatchObject({
          state: "ready",
          data: {
            data: expect.arrayContaining([
              expect.objectContaining({ install_id: "concurrent-mysql-0" }),
            ]),
          },
        });
      });
    });
  },
);
