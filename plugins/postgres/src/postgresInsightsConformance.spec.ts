import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleEventRow,
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationPageInput,
} from "@hot-updater/plugin-core";
import type {
  DatabasePluginImplementation,
  RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";
import {
  type RequiredInsightsModelConformanceHarness,
  registerRequiredInsightsModelTests,
} from "@hot-updater/test-utils";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, vi } from "vitest";

import {
  migratePostgresInsightsInstallationEvents,
  migratePostgresInsightsLive,
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import { createPostgresInsightsQueries } from "./postgresInsightsQueries";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import {
  appendPostgresInsightsEvent,
  createPostgresInsightsSourceTools,
  postgresEventSourceShard,
} from "./postgresInsightsSource";
import type { Database } from "./types";

const candidateTables = [
  "bundle_events",
  "private_hot_updater_insights_live_installations",
  "private_hot_updater_insights_report_aliases",
  "private_hot_updater_insights_report_latest",
  "private_hot_updater_insights_report_counts",
  "private_hot_updater_insights_report_order_rows",
] as const;

class PostgresCandidateMeter {
  #current = 0;
  #last = 0;
  #currentRequests = 0;
  #lastRequests = 0;
  #measuring = false;
  #sawCandidateRead = false;

  async measure<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    this.#current = 0;
    this.#currentRequests = 0;
    this.#measuring = true;
    this.#sawCandidateRead = false;
    let succeeded = false;
    try {
      const result = await operation();
      succeeded = true;
      return result;
    } finally {
      if (succeeded || this.#sawCandidateRead) this.#last = this.#current;
      this.#lastRequests = this.#currentRequests;
      this.#measuring = false;
    }
  }

  record(sqlText: string, rowCount: number): void {
    if (!this.#measuring) return;
    this.#currentRequests += 1;
    const normalized = sqlText.toLowerCase();
    if (
      !normalized.trimStart().startsWith("select") ||
      !candidateTables.some(
        (table) =>
          normalized.includes(`from "${table}"`) ||
          normalized.includes(`from ${table}`),
      )
    ) {
      return;
    }
    this.#sawCandidateRead = true;
    this.#current += rowCount;
  }

  get last(): number {
    return this.#last;
  }

  get lastRequests(): number {
    return this.#lastRequests;
  }

  get currentRequests(): number {
    return this.#currentRequests;
  }
}

type PostgresNamespace = {
  readonly path: string;
  readonly meter: PostgresCandidateMeter;
  readonly databaseNamespace: string;
  client: PGlite;
  db: Kysely<Database>;
};

const harnesses: {
  readonly root: string;
  readonly namespaces: readonly PostgresNamespace[];
}[] = [];

const unsupported = async (): Promise<never> => {
  throw new Error("unexpected generic database operation");
};

const implementation = (
  namespace: PostgresNamespace,
): DatabasePluginImplementation => ({
  appendBundleEvent: (row) =>
    appendPostgresInsightsEvent(namespace.db, row).then(() => undefined),
  create: unsupported,
  update: unsupported,
  delete: unsupported,
  count: unsupported,
  findOne: unsupported,
  findMany: unsupported,
  insertChannel: unsupported,
  deleteChannel: unsupported,
});

const openNamespace = async (
  path: string,
  meter: PostgresCandidateMeter,
): Promise<Pick<PostgresNamespace, "client" | "db">> => {
  const client = new PGlite(path);
  await client.waitReady;
  const originalQuery = client.query.bind(client);
  Object.defineProperty(client, "query", {
    configurable: true,
    value: async (query: string, params?: unknown[]) => {
      const result = await originalQuery(query, params);
      meter.record(query, result.rows.length);
      return result;
    },
  });
  const db = new Kysely<Database>({ dialect: new PGliteDialect(client) });
  return { client, db };
};

const createNamespace = async (
  path: string,
  bundlesSql: string,
): Promise<PostgresNamespace> => {
  const meter = new PostgresCandidateMeter();
  const opened = await openNamespace(path, meter);
  const namespace = { path, meter, ...opened };
  await namespace.client.exec(bundlesSql);
  await migratePostgresInsightsInstallationEvents(namespace.db);
  await migratePostgresInsightsSource(namespace.db);
  await createPostgresInsightsSourceTools(namespace.db).backfillStep(10);
  await migratePostgresInsightsLive(namespace.db);
  await createPostgresInsightsLiveTools(namespace.db).backfillStep(10);
  await migratePostgresInsightsReports(namespace.db);
  const identity = await sql<{ source_id: string }>`select source_id::text
    from private_hot_updater_insights_source_state where id=1`.execute(
    namespace.db,
  );
  return {
    ...namespace,
    databaseNamespace: identity.rows[0]!.source_id,
  };
};

const reopenNamespace = async (namespace: PostgresNamespace): Promise<void> => {
  await namespace.db.destroy();
  await namespace.client.close();
  const opened = await openNamespace(namespace.path, namespace.meter);
  namespace.client = opened.client;
  namespace.db = opened.db;
};

const instrumentModel = (
  model: RequiredInsightsModel,
  meter: PostgresCandidateMeter,
  beforeOperation: () => Promise<void>,
  afterOperation: () => Promise<void>,
): RequiredInsightsModel => {
  function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    return meter.measure(async () => {
      await beforeOperation();
      const result = await model.pageInstallations(input);
      await afterOperation();
      return result;
    });
  }

  return {
    append: (row: BundleEventRow) =>
      meter.measure(async () => {
        await beforeOperation();
        const result = await model.append(row);
        await afterOperation();
        return result;
      }),
    pageEvents: (input) =>
      meter.measure(async () => {
        await beforeOperation();
        const result = await model.pageEvents(input);
        await afterOperation();
        return result;
      }),
    pageInstallations,
    getReport: (input) =>
      meter.measure(async () => {
        await beforeOperation();
        const result = await model.getReport(input);
        await afterOperation();
        return result;
      }),
    pageReport: (input) =>
      meter.measure(async () => {
        await beforeOperation();
        const result = await model.pageReport(input);
        await afterOperation();
        return result;
      }),
  };
};

const deletePublication = async (
  db: Kysely<Database>,
  publicationId: string,
): Promise<void> => {
  await db.transaction().execute(async (transaction) => {
    await sql`update private_hot_updater_insights_report_heads
      set active_job_id=null, publication_job_id=null
      where active_job_id=${publicationId}::uuid
        or publication_job_id=${publicationId}::uuid`.execute(transaction);
    for (const table of [
      "private_hot_updater_insights_report_members",
      "private_hot_updater_insights_report_latest",
      "private_hot_updater_insights_report_aliases",
      "private_hot_updater_insights_report_counts",
      "private_hot_updater_insights_report_order_rows",
      "private_hot_updater_insights_report_order_states",
    ]) {
      await sql`delete from ${sql.table(table)} where job_id=${publicationId}::uuid`.execute(
        transaction,
      );
    }
    await sql`delete from private_hot_updater_insights_report_jobs
      where id=${publicationId}::uuid`.execute(transaction);
  });
};

const createHarness =
  async (): Promise<RequiredInsightsModelConformanceHarness> => {
    const root = await mkdtemp(
      join(tmpdir(), "hot-updater-postgres-insights-"),
    );
    const bundlesSql = await readFile(
      "plugins/postgres/sql/bundles.sql",
      "utf8",
    );
    const primary = await createNamespace(join(root, "primary"), bundlesSql);
    const other = await createNamespace(join(root, "other"), bundlesSql);
    harnesses.push({ root, namespaces: [primary, other] });
    const completed = new Set<string>();
    const otherCompleted = new Set<string>();
    const pendingExpiry = new Set<string>();
    let currentTimeMs = 0;

    const applyExpiry = async (): Promise<void> => {
      for (const publicationId of pendingExpiry) {
        await deletePublication(primary.db, publicationId);
        pendingExpiry.delete(publicationId);
      }
    };

    const freezeReservedAsOf = async (
      namespace: PostgresNamespace,
    ): Promise<void> => {
      await sql`update private_hot_updater_insights_report_jobs
        set as_of_ms=${currentTimeMs}
        where base_job_id is null and status in ('queued','preparing')`.execute(
        namespace.db,
      );
    };

    const runNamespaceJobStep = async (
      namespace: PostgresNamespace,
      completedJobs: Set<string>,
      jobId: string,
      input: { readonly maxItems: number; readonly maxRequests: number },
    ) => {
      if (input.maxItems > 4_096 || input.maxRequests > 4_096)
        await createPostgresInsightsReportWorker(namespace.db).runStep(input);
      if (input.maxItems < 100 || input.maxRequests < 10)
        return {
          state: "idle" as const,
          jobId,
          usage: { items: 0, requests: 0 },
        };
      let result: Awaited<
        ReturnType<
          ReturnType<typeof createPostgresInsightsReportWorker>["runStep"]
        >
      >;
      let processed = 0;
      try {
        result = await namespace.meter.measure(async () => {
          const target = await sql<{ status: string }>`select status
            from private_hot_updater_insights_report_jobs
            where id=${jobId}::uuid`.execute(namespace.db);
          if (target.rows[0]?.status === "ready")
            return { state: "published" as const, processed: 0, jobId };
          if (target.rows[0]?.status === "failed")
            return { state: "failed" as const, processed: 0, jobId };
          let current = await createPostgresInsightsReportWorker(
            namespace.db,
          ).runStep(input);
          processed += current.processed;
          for (
            let attempt = 1;
            attempt < 4 &&
            current.state !== "published" &&
            current.state !== "failed" &&
            namespace.meter.currentRequests < 80;
            attempt++
          ) {
            current = await createPostgresInsightsReportWorker(
              namespace.db,
            ).runStep(input);
            processed += current.processed;
          }
          return current;
        });
      } catch (error) {
        const failed = await sql<{ status: string }>`select status
          from private_hot_updater_insights_report_jobs
          where id=${jobId}::uuid`.execute(namespace.db);
        if (failed.rows[0]?.status !== "failed") throw error;
        return {
          state: "failed" as const,
          jobId,
          usage: { items: 0, requests: namespace.meter.lastRequests },
        };
      }
      const usage = {
        items: processed,
        requests: namespace.meter.lastRequests,
      };
      if (result.jobId !== undefined && result.jobId !== jobId)
        return { state: "idle" as const, jobId, usage };
      if (result.state === "published") {
        completedJobs.add(jobId);
        return {
          state: "complete" as const,
          publicationId: jobId,
          usage,
        };
      }
      if (result.state === "failed")
        return { state: "failed" as const, jobId, usage };
      if (result.state === "progress")
        return result.processed > 0
          ? { state: "running" as const, jobId, usage }
          : { state: "idle" as const, jobId, usage };
      return { state: "idle" as const, jobId, usage };
    };

    const createFacade = (): RequiredInsightsModelConformanceHarness => {
      const primaryModel = createPostgresInsightsQueries(
        primary.db,
        implementation(primary),
        primary.databaseNamespace,
      );
      const otherModel = createPostgresInsightsQueries(
        other.db,
        implementation(other),
        other.databaseNamespace,
      );
      return {
        model: instrumentModel(primaryModel, primary.meter, applyExpiry, () =>
          freezeReservedAsOf(primary),
        ),
        otherNamespaceModel: instrumentModel(
          otherModel,
          other.meter,
          async () => undefined,
          () => freezeReservedAsOf(other),
        ),
        async runJobStep(jobId, input) {
          await applyExpiry();
          return runNamespaceJobStep(primary, completed, jobId, input);
        },
        runOtherNamespaceJobStep(jobId, input) {
          return runNamespaceJobStep(other, otherCompleted, jobId, input);
        },
        async reopen() {
          await Promise.all([reopenNamespace(primary), reopenNamespace(other)]);
          return createFacade();
        },
        async insertMigrationPoisonRow() {
          const id = "00000000-0000-7000-8000-00000000000a";
          const shard = postgresEventSourceShard(id);
          const installId = "p".repeat(1_025);
          const poisonEvent: BundleEventRow = {
            id,
            type: "UPDATE_APPLIED",
            install_id: installId,
            user_id: "poison",
            username: "poison",
            from_release_id: null,
            from_bundle_id: "10000000-0000-7000-8000-000000000002",
            to_release_id: null,
            to_bundle_id: "10000000-0000-7000-8000-000000000001",
            platform: "ios",
            app_version: "1.0.0",
            channel: "production",
            cohort: "poison",
            update_strategy: "appVersion",
            fingerprint_hash: null,
            sdk_version: null,
            received_at_ms: 999,
          };
          await primary.db.transaction().execute(async (transaction) => {
            const allocated = await sql<{ sequence: string }>`update
              private_hot_updater_insights_source_clocks
              set committed_seq=committed_seq+1 where shard=${shard}
              returning committed_seq::text sequence`.execute(transaction);
            await sql`insert into bundle_events (
              id,type,install_id,user_id,username,from_release_id,
              from_bundle_id,to_release_id,to_bundle_id,platform,app_version,
              channel,cohort,update_strategy,fingerprint_hash,sdk_version,
              received_at_ms,insights_source_shard,insights_source_seq,
              insights_event,insights_live_version
            ) values (
              ${id}::uuid,'UPDATE_APPLIED',${installId},'poison','poison',null,
              '10000000-0000-7000-8000-000000000002'::uuid,null,
              '10000000-0000-7000-8000-000000000001'::uuid,'ios',
              '1.0.0','production','poison','appVersion',null,null,999,${shard},
              ${allocated.rows[0]!.sequence}::bigint,
              ${JSON.stringify(poisonEvent)}::jsonb,1
            )`.execute(transaction);
          });
        },
        setCurrentTimeMs(nowMs) {
          if (!Number.isSafeInteger(nowMs) || nowMs < 0)
            throw new Error("invalid-time");
          currentTimeMs = nowMs;
          vi.setSystemTime(nowMs);
        },
        expirePublication(publicationId) {
          completed.delete(publicationId);
          pendingExpiry.add(publicationId);
        },
        publicationStateForJob(jobId) {
          return completed.has(jobId) ? "complete" : "absent";
        },
        getLastStorageReadCount(namespace = "primary") {
          return namespace === "primary"
            ? primary.meter.last
            : other.meter.last;
        },
        getPageEventsCandidateReadBudget(input) {
          return input.selector.kind === "all"
            ? input.limit + 1
            : (input.limit + 1) * 2;
        },
        getPageInstallationsCandidateReadBudget(input) {
          return input.kind === "installationId" ? 1 : input.limit + 1;
        },
        getPageReportCandidateReadBudget(input) {
          return input.limit + 1;
        },
      };
    };
    return createFacade();
  };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async ({ root, namespaces }) => {
      await Promise.all(
        namespaces.map(async ({ db, client }) => {
          await db.destroy();
          await client.close();
        }),
      );
      await rm(root, { recursive: true, force: true });
    }),
  );
  vi.useRealTimers();
});

registerRequiredInsightsModelTests(createHarness);
