import { DatabaseSync, type SqliteValue } from "node:sqlite";

import type {
  BundleEventRow,
  InsightsModel,
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
import { assertInsightsMaintenanceInputContract } from "@hot-updater/plugin-core/internal";
import {
  type InsightsMaintenanceStepResult,
  type InsightsModelConformanceHarness,
  type InsightsModelConformanceNamespaces,
  registerInsightsModelTests,
} from "@hot-updater/test-utils";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, vi } from "vitest";

import { kyselyAdapter } from "../../kysely";
import { tables } from "./constants";
import { stepKyselyInsightsSearch } from "./installations";
import { stepKyselyInsightsReport } from "./reports";

const candidateTables = [
  tables.events,
  tables.live,
  tables.liveVersions,
  tables.searchRows,
  tables.reportCounts,
  tables.reportOrder,
] as const;

class SqliteCandidateMeter {
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
    try {
      return await operation();
    } finally {
      if (this.#sawCandidateRead) this.#last = this.#current;
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
      !candidateTables.some((table) => normalized.includes(`from "${table}"`))
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
}

type SqliteNamespace = {
  readonly db: Kysely<object>;
  readonly native: DatabaseSync;
  readonly meter: SqliteCandidateMeter;
  readonly databaseNamespace: string;
};

const namespaces: SqliteNamespace[] = [];

const createNamespace = async (
  databaseNamespace: string,
): Promise<SqliteNamespace> => {
  const native = new DatabaseSync(":memory:");
  const meter = new SqliteCandidateMeter();
  const db = new Kysely<object>({
    dialect: new SqliteDialect({
      database: {
        close: () => native.close(),
        prepare: (text) => {
          const statement = native.prepare(text);
          return {
            reader: statement.columns().length > 0,
            all: (parameters) => {
              const rows = statement.all(...(parameters as SqliteValue[]));
              meter.record(text, rows.length);
              return rows;
            },
            run: (parameters) => {
              const result = statement.run(...(parameters as SqliteValue[]));
              meter.record(text, 0);
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
            iterate: (parameters) =>
              statement.iterate(...(parameters as SqliteValue[])),
          };
        },
      },
    }),
  });
  const namespace = { db, native, meter, databaseNamespace };
  namespaces.push(namespace);
  const adapter = kyselyAdapter({
    db,
    provider: "sqlite",
    insightsDatabaseNamespace: databaseNamespace,
  });
  await adapter.createMigrator!()
    .migrateToLatest()
    .then((migration) => migration.execute());
  return namespace;
};

const instrumentModel = (
  model: InsightsModel,
  meter: SqliteCandidateMeter,
): InsightsModel => {
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
    if (input.kind === "all" || input.kind === "installationId") {
      return meter.measure(() => model.pageInstallations(input));
    }
    return meter.measure(() => model.pageInstallations(input));
  }

  return {
    append: (row: BundleEventRow) => meter.measure(() => model.append(row)),
    runMaintenanceStep: (input) => model.runMaintenanceStep(input),
    pageEvents: (input) => meter.measure(() => model.pageEvents(input)),
    pageInstallations,
    getReport: (input) => meter.measure(() => model.getReport(input)),
    pageReport: (input) => meter.measure(() => model.pageReport(input)),
  };
};

const deletePublication = (native: DatabaseSync, id: string): void => {
  native.exec("begin immediate");
  try {
    native
      .prepare(
        `update ${tables.searchHeads} set active_job_id = null,
          publication_job_id = null, failed_job_id = null
          where active_job_id = ? or publication_job_id = ?
            or failed_job_id = ?`,
      )
      .run(id, id, id);
    native
      .prepare(
        `update ${tables.reportHeads} set active_job_id = null,
          publication_job_id = null, failed_job_id = null
          where active_job_id = ? or publication_job_id = ?
            or failed_job_id = ?`,
      )
      .run(id, id, id);
    native.prepare(`delete from ${tables.searchRows} where job_id = ?`).run(id);
    native.prepare(`delete from ${tables.searchJobs} where id = ?`).run(id);
    for (const table of [
      tables.reportMembers,
      tables.reportLatest,
      tables.reportCounts,
      tables.reportOrder,
      tables.reportPageTotals,
    ]) {
      native.prepare(`delete from ${table} where job_id = ?`).run(id);
    }
    native.prepare(`delete from ${tables.reportJobs} where id = ?`).run(id);
    native.exec("commit");
  } catch (error) {
    native.exec("rollback");
    throw error;
  }
};

const createHarness = async (
  namespaces: InsightsModelConformanceNamespaces,
): Promise<InsightsModelConformanceHarness> => {
  const primary = await createNamespace(namespaces.insightsDatabaseNamespace);
  const other = await createNamespace(
    namespaces.otherInsightsDatabaseNamespace,
  );
  const primaryModel = kyselyAdapter({
    db: primary.db,
    provider: "sqlite",
    insightsDatabaseNamespace: primary.databaseNamespace,
  }).models.insights;
  const otherModel = kyselyAdapter({
    db: other.db,
    provider: "sqlite",
    insightsDatabaseNamespace: other.databaseNamespace,
  }).models.insights;
  const runTargetedJobStep = async (
    namespace: SqliteNamespace,
    jobId: string,
    input: { readonly maxItems: number; readonly maxRequests: number },
  ): Promise<InsightsMaintenanceStepResult> => {
    assertInsightsMaintenanceInputContract(input);
    const search = namespace.native
      .prepare(`select id from ${tables.searchJobs} where id = ?`)
      .get(jobId);
    const report = namespace.native
      .prepare(`select id from ${tables.reportJobs} where id = ?`)
      .get(jobId);
    if (search === undefined && report === undefined) {
      throw new Error("unknown-job");
    }
    if (
      (search !== undefined && input.maxRequests < 13) ||
      (report !== undefined && input.maxRequests < 10)
    ) {
      return {
        state: "idle",
        jobId,
        usage: { items: 0, requests: 1 },
      };
    }
    const update =
      search !== undefined
        ? await namespace.meter.measure(() =>
            stepKyselyInsightsSearch(
              namespace.db,
              "sqlite",
              jobId,
              Math.min(input.maxItems, Math.floor((input.maxRequests - 6) / 5)),
            ),
          )
        : await namespace.meter.measure(() =>
            stepKyselyInsightsReport(namespace.db, "sqlite", jobId, input),
          );
    const usage = {
      items: update.processed,
      requests: namespace.meter.lastRequests + 1,
    };
    return update.job.state === "ready"
      ? { state: "complete", publicationId: jobId, usage }
      : update.job.state === "failed"
        ? { state: "failed", jobId, usage }
        : update.advanced
          ? { state: "running", jobId, usage }
          : { state: "idle", jobId, usage };
  };

  const createFacade = (): InsightsModelConformanceHarness => ({
    model: instrumentModel(primaryModel, primary.meter),
    otherNamespaceModel: instrumentModel(otherModel, other.meter),
    runJobStep: (jobId, input) => runTargetedJobStep(primary, jobId, input),
    runOtherNamespaceJobStep: (jobId, input) =>
      runTargetedJobStep(other, jobId, input),
    reopen: createFacade,
    insertMigrationPoisonRow() {
      primary.native.exec("begin immediate");
      try {
        for (const table of [
          tables.events,
          tables.liveVersions,
          tables.aliases,
        ]) {
          primary.native
            .prepare(`update ${table} set source_seq = source_seq + 1000`)
            .run();
          primary.native
            .prepare(`update ${table} set source_seq = source_seq - 999`)
            .run();
        }
        primary.native
          .prepare(
            `update ${tables.live} set source_seq = source_seq + 1,
                first_source_seq = first_source_seq + 1`,
          )
          .run();
        primary.native
          .prepare(
            `insert into ${tables.events} (
            event_id, source_seq, received_at_ms, install_key, install_id,
            event_type, to_bundle_id, from_bundle_id, raw_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "00000000-0000-7000-8000-0000000000ff",
            1,
            999,
            "f".repeat(64),
            "poison-installation",
            "UNCHANGED",
            "10000000-0000-7000-8000-000000000001",
            null,
            "{",
          );
        primary.native
          .prepare(`update ${tables.state} set next_seq = next_seq + 1`)
          .run();
        primary.native.exec("commit");
      } catch (error) {
        primary.native.exec("rollback");
        throw error;
      }
    },
    setCurrentTimeMs(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new Error("invalid-time");
      }
      vi.setSystemTime(nowMs);
    },
    expirePublication(publicationId) {
      deletePublication(primary.native, publicationId);
    },
    publicationStateForJob(jobId) {
      const search = primary.native
        .prepare(`select state from ${tables.searchJobs} where id = ?`)
        .get(jobId) as { state: string } | undefined;
      const report = primary.native
        .prepare(`select state from ${tables.reportJobs} where id = ?`)
        .get(jobId) as { state: string } | undefined;
      return search?.state === "ready" || report?.state === "ready"
        ? "complete"
        : "absent";
    },
    getLastStorageReadCount(namespace = "primary") {
      return namespace === "primary" ? primary.meter.last : other.meter.last;
    },
    getPageEventsCandidateReadBudget(input) {
      return input.selector.kind === "all"
        ? input.limit + 1
        : (input.limit + 1) * 2;
    },
    getPageInstallationsCandidateReadBudget(input) {
      return input.kind === "installationId" ? 2 : input.limit + 1;
    },
    getPageReportCandidateReadBudget(input) {
      return input.limit + 1;
    },
  });
  return createFacade();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  await Promise.all(namespaces.splice(0).map(({ db }) => db.destroy()));
  vi.useRealTimers();
});

registerInsightsModelTests(createHarness);
