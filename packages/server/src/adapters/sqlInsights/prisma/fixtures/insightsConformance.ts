import type {
  BundleEventRow,
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationPageInput,
  InsightsReportPageInput,
  InsightsModel,
} from "@hot-updater/plugin-core";
import type {
  InsightsMaintenanceStepResult,
  InsightsModelConformanceNamespaces,
  InsightsModelConformanceHarness,
} from "@hot-updater/test-utils";

import type { ORMSQLProvider } from "../../../../db/types";
import {
  assertPrismaInsightsClient,
  executePrismaInsights,
  PrismaInsightsSql,
  queryPrismaInsights,
  runPrismaInsightsTransaction,
  type PrismaInsightsClient,
  type PrismaInsightsRawClient,
} from "../client";
import { prismaInsightsEventOrder, prismaInsightsInstallKey } from "../codec";
import { preparePrismaInsights } from "../maintenance";
import { createPrismaInsightsModel } from "../model";
import { runPrismaInsightsReportStep } from "../reports";
import {
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_ALIASES,
  PRISMA_INSIGHTS_LIVE,
  PRISMA_INSIGHTS_REPORT_COUNTS,
  PRISMA_INSIGHTS_REPORT_HEADS,
  PRISMA_INSIGHTS_REPORT_JOBS,
  PRISMA_INSIGHTS_REPORT_LATEST,
  PRISMA_INSIGHTS_REPORT_MEMBERS,
  PRISMA_INSIGHTS_REPORT_ORDER,
  PRISMA_INSIGHTS_REPORT_SORT,
  PRISMA_INSIGHTS_SEARCH_HEADS,
  PRISMA_INSIGHTS_SEARCH_JOBS,
  PRISMA_INSIGHTS_SEARCH_ROWS,
  PRISMA_INSIGHTS_SOURCE,
} from "../schema";
import { runPrismaInsightsSearchStep } from "../search";

const databaseTimeStatements: Readonly<Record<ORMSQLProvider, string>> = {
  postgresql:
    "select floor(extract(epoch from statement_timestamp())*1000)::float8 as observed_at_ms",
  cockroachdb:
    "select floor(extract(epoch from statement_timestamp())*1000)::float8 as observed_at_ms",
  mysql:
    "select floor(unix_timestamp(current_timestamp(3))*1000) as observed_at_ms",
  sqlite:
    "select cast(round((julianday('now')-2440587.5)*86400000) as integer) as observed_at_ms",
  mssql:
    "select datediff_big(millisecond,'1970-01-01',sysutcdatetime()) as observed_at_ms",
};

const candidateTables = [
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_LIVE,
  PRISMA_INSIGHTS_SEARCH_ROWS,
  PRISMA_INSIGHTS_REPORT_COUNTS,
  PRISMA_INSIGHTS_REPORT_ORDER,
  PRISMA_INSIGHTS_REPORT_SORT,
] as const;

type JobKind = "search" | "report";
type JobState = "queued" | "preparing" | "ready" | "failed";
type JobRow = { readonly job_kind: JobKind; readonly state: JobState };
type StepWithoutUsage =
  | { readonly state: "complete"; readonly publicationId: string }
  | { readonly state: "running"; readonly jobId: string }
  | { readonly state: "idle"; readonly jobId: string }
  | { readonly state: "failed"; readonly jobId: string };

export interface PrismaInsightsConformanceNamespace {
  readonly client: object;
  /** Reopens the same durable database and returns a fresh Prisma client. */
  reopen(): Promise<object>;
  dispose(): Promise<void>;
}

export interface PrismaInsightsConformanceBudgets {
  pageEvents(input: InsightsPageEventsInput): number;
  pageInstallations(input: InsightsInstallationPageInput): number;
  pageReport(input: InsightsReportPageInput): number;
}

export interface PrismaInsightsConformanceOptions {
  readonly provider: ORMSQLProvider;
  readonly createNamespace: () =>
    | PrismaInsightsConformanceNamespace
    | Promise<PrismaInsightsConformanceNamespace>;
  readonly budgets?: Partial<PrismaInsightsConformanceBudgets>;
}

export interface PrismaInsightsConformanceFixture {
  readonly createHarness: (
    namespaces: InsightsModelConformanceNamespaces,
  ) => Promise<InsightsModelConformanceHarness>;
  dispose(): Promise<void>;
}

class NativeRequestMeter {
  #candidateRows = 0;
  #lastCandidateRows = 0;
  #requests = 0;
  #lastRequests = 0;
  #measuring = false;
  #sawCandidateRead = false;

  async measure<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (this.#measuring) return operation();
    this.#candidateRows = 0;
    this.#requests = 0;
    this.#sawCandidateRead = false;
    this.#measuring = true;
    try {
      return await operation();
    } finally {
      if (this.#sawCandidateRead) {
        this.#lastCandidateRows = this.#candidateRows;
      }
      this.#lastRequests = this.#requests;
      this.#measuring = false;
    }
  }

  recordRequest(query: string, rowCount: number): void {
    if (!this.#measuring) return;
    this.#requests += 1;
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (
      !normalized.startsWith("select") ||
      !candidateTables.some((table) =>
        normalized.includes(`from ${table.toLowerCase()}`),
      )
    ) {
      return;
    }
    this.#sawCandidateRead = true;
    this.#candidateRows += rowCount;
  }

  recordDelegateRequest(): void {
    if (this.#measuring) this.#requests += 1;
  }

  get lastCandidateRows(): number {
    return this.#lastCandidateRows;
  }

  get lastRequests(): number {
    return this.#lastRequests;
  }

  get currentRequests(): number {
    return this.#requests;
  }
}

type ClientControls = {
  nowMs: number;
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const createMeasuredClient = (
  rawClient: object,
  provider: ORMSQLProvider,
  meter: NativeRequestMeter,
  controls: ClientControls,
): PrismaInsightsClient => {
  const delegateCache = new WeakMap<object, object>();

  const wrapObject = (target: object, transaction: boolean): object =>
    new Proxy(target, {
      get(inner, property) {
        if (property === "$queryRawUnsafe") {
          return async <TResult>(query: string, ...values: unknown[]) => {
            if (query === databaseTimeStatements[provider]) {
              meter.recordRequest(query, 1);
              return [{ observed_at_ms: controls.nowMs }] as TResult;
            }
            const operation = Reflect.get(inner, property);
            if (typeof operation !== "function") {
              throw new Error("missing Prisma raw query method");
            }
            const result = (await Reflect.apply(operation, inner, [
              query,
              ...values,
            ])) as TResult;
            meter.recordRequest(
              query,
              Array.isArray(result) ? result.length : 0,
            );
            return result;
          };
        }
        if (property === "$executeRawUnsafe") {
          return async (query: string, ...values: unknown[]) => {
            const operation = Reflect.get(inner, property);
            if (typeof operation !== "function") {
              throw new Error("missing Prisma raw execute method");
            }
            const result = (await Reflect.apply(operation, inner, [
              query,
              ...values,
            ])) as number;
            meter.recordRequest(query, 0);
            return result;
          };
        }
        if (!transaction && property === "$transaction") {
          return async <TResult>(
            callback: (client: object) => Promise<TResult>,
            options?: {
              readonly isolationLevel: "Serializable";
              readonly maxWait?: number;
              readonly timeout?: number;
            },
          ): Promise<TResult> => {
            const operation = Reflect.get(inner, property);
            if (typeof operation !== "function") {
              throw new Error("missing Prisma transaction method");
            }
            return Reflect.apply(operation, inner, [
              (transactionClient: object) =>
                callback(wrapObject(transactionClient, true)),
              options,
            ]) as Promise<TResult>;
          };
        }
        const value = Reflect.get(inner, property, inner);
        if (typeof value === "function") return value.bind(inner);
        if (!isRecord(value)) return value;
        const cached = delegateCache.get(value);
        if (cached !== undefined) return cached;
        const delegate = new Proxy(value, {
          get(delegateTarget, delegateProperty) {
            const member = Reflect.get(
              delegateTarget,
              delegateProperty,
              delegateTarget,
            );
            if (typeof member !== "function") return member;
            return (...arguments_: readonly unknown[]) => {
              meter.recordDelegateRequest();
              return Reflect.apply(member, delegateTarget, arguments_);
            };
          },
        });
        delegateCache.set(value, delegate);
        return delegate;
      },
    });

  const wrapped = wrapObject(rawClient, false);
  assertPrismaInsightsClient(wrapped);
  return wrapped;
};

const instrumentModel = (
  model: InsightsModel,
  meter: NativeRequestMeter,
  beforeOperation: () => Promise<void>,
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
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    await beforeOperation();
    return meter.measure(() => model.pageInstallations(input));
  }

  return {
    async append(row: BundleEventRow) {
      await beforeOperation();
      return meter.measure(() => model.append(row));
    },
    runMaintenanceStep: (input) => model.runMaintenanceStep(input),
    async pageEvents(input) {
      await beforeOperation();
      return meter.measure(() => model.pageEvents(input));
    },
    pageInstallations,
    async getReport(input) {
      await beforeOperation();
      return meter.measure(() => model.getReport(input));
    },
    async pageReport(input) {
      await beforeOperation();
      return meter.measure(() => model.pageReport(input));
    },
  };
};

type ActiveNamespace = {
  readonly namespace: PrismaInsightsConformanceNamespace;
  readonly databaseNamespace: string;
  readonly meter: NativeRequestMeter;
  readonly controls: ClientControls;
  client: PrismaInsightsClient;
};

const activateNamespace = async (
  namespace: PrismaInsightsConformanceNamespace,
  provider: ORMSQLProvider,
  databaseNamespace: string,
): Promise<ActiveNamespace> => {
  assertPrismaInsightsClient(namespace.client);
  const preparation = await preparePrismaInsights(
    namespace.client,
    provider,
    databaseNamespace,
    { writersDrained: true },
  );
  if (!preparation.ready) {
    throw new Error("Prisma conformance namespace is not source-ready");
  }
  const meter = new NativeRequestMeter();
  const controls: ClientControls = { nowMs: 0 };
  return {
    namespace,
    databaseNamespace,
    meter,
    controls,
    client: createMeasuredClient(namespace.client, provider, meter, controls),
  };
};

const reopenNamespace = async (
  active: ActiveNamespace,
  provider: ORMSQLProvider,
): Promise<void> => {
  const reopened = await active.namespace.reopen();
  assertPrismaInsightsClient(reopened);
  active.client = createMeasuredClient(
    reopened,
    provider,
    active.meter,
    active.controls,
  );
};

const readJob = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
): Promise<JobRow | null> => {
  const sql = new PrismaInsightsSql(provider);
  const searchId = sql.value(jobId);
  const reportId = sql.value(jobId);
  const rows = await queryPrismaInsights<JobRow[]>(
    client,
    sql.statement(
      `select 'search' as job_kind,state from ${PRISMA_INSIGHTS_SEARCH_JOBS}
       where id=${searchId}
       union all
       select 'report' as job_kind,state from ${PRISMA_INSIGHTS_REPORT_JOBS}
       where id=${reportId}`,
    ),
  );
  if (rows.length > 1) throw new Error("duplicate Prisma Insights job id");
  return rows[0] ?? null;
};

const deletePublication = async (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  publicationId: string,
): Promise<void> => {
  await runPrismaInsightsTransaction(client, provider, async (transaction) => {
    for (const table of [
      PRISMA_INSIGHTS_SEARCH_HEADS,
      PRISMA_INSIGHTS_REPORT_HEADS,
    ]) {
      const sql = new PrismaInsightsSql(provider);
      await executePrismaInsights(
        transaction,
        sql.statement(
          `update ${table} set active_job_id=null,publication_job_id=null
           where active_job_id=${sql.value(publicationId)}
              or publication_job_id=${sql.value(publicationId)}`,
        ),
      );
    }
    for (const table of [
      PRISMA_INSIGHTS_SEARCH_ROWS,
      PRISMA_INSIGHTS_REPORT_MEMBERS,
      PRISMA_INSIGHTS_REPORT_LATEST,
      PRISMA_INSIGHTS_REPORT_COUNTS,
      PRISMA_INSIGHTS_REPORT_ORDER,
      PRISMA_INSIGHTS_REPORT_SORT,
    ]) {
      const sql = new PrismaInsightsSql(provider);
      await executePrismaInsights(
        transaction,
        sql.statement(
          `delete from ${table} where job_id=${sql.value(publicationId)}`,
        ),
      );
    }
    for (const table of [
      PRISMA_INSIGHTS_SEARCH_JOBS,
      PRISMA_INSIGHTS_REPORT_JOBS,
    ]) {
      const sql = new PrismaInsightsSql(provider);
      await executePrismaInsights(
        transaction,
        sql.statement(
          `delete from ${table} where id=${sql.value(publicationId)}`,
        ),
      );
    }
  });
};

const insertPoison = async (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
): Promise<void> => {
  const eventId = "00000000-0000-7000-8000-0000000000ff";
  const installId = "poison-installation";
  await runPrismaInsightsTransaction(client, provider, async (transaction) => {
    for (const table of [PRISMA_INSIGHTS_EVENTS]) {
      await executePrismaInsights(
        transaction,
        new PrismaInsightsSql(provider).statement(
          `update ${table} set source_generation=source_generation+1000`,
        ),
      );
      await executePrismaInsights(
        transaction,
        new PrismaInsightsSql(provider).statement(
          `update ${table} set source_generation=source_generation-999`,
        ),
      );
    }
    for (const table of [PRISMA_INSIGHTS_LIVE, PRISMA_INSIGHTS_ALIASES]) {
      await executePrismaInsights(
        transaction,
        new PrismaInsightsSql(provider).statement(
          `update ${table} set source_generation=source_generation+1`,
        ),
      );
    }
    await executePrismaInsights(
      transaction,
      new PrismaInsightsSql(provider).statement(
        `update ${PRISMA_INSIGHTS_SOURCE} set generation=generation+1 where id=1`,
      ),
    );
    const sql = new PrismaInsightsSql(provider);
    const values = [
      eventId,
      1,
      999,
      prismaInsightsEventOrder(eventId),
      prismaInsightsInstallKey(installId),
      installId,
      "UNCHANGED",
      "10000000-0000-7000-8000-000000000001",
      null,
      "{",
    ].map((value) => sql.value(value));
    await executePrismaInsights(
      transaction,
      sql.statement(
        `insert into ${PRISMA_INSIGHTS_EVENTS} (
          event_id,source_generation,received_at_ms,event_order,install_key,
          install_id,type,to_bundle_id,from_bundle_id,event_json
        ) values (${values.join(",")})`,
      ),
    );
  });
};

const defaultBudgets: PrismaInsightsConformanceBudgets = {
  pageEvents: (input) =>
    input.selector.kind === "all" ? input.limit + 1 : (input.limit + 1) * 2,
  pageInstallations: (input) =>
    input.kind === "installationId" ? 1 : input.limit + 1,
  pageReport: (input) => input.limit * 8 + 16,
};

const runMeasuredJobStep = async (
  active: ActiveNamespace,
  provider: ORMSQLProvider,
  completed: Set<string>,
  jobId: string,
  input: { readonly maxItems: number; readonly maxRequests: number },
): Promise<InsightsMaintenanceStepResult> => {
  if (
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > 4_096 ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1 ||
    input.maxRequests > 4_096
  ) {
    throw new Error("invalid maintenance input");
  }
  let result: StepWithoutUsage;
  let processed = 0;
  await active.meter.measure(async () => {
    const job = await readJob(active.client, provider, jobId);
    if (job === null || input.maxRequests < 10) {
      result = { state: "idle", jobId };
      return;
    }
    const maxItems = Math.min(200, input.maxItems);
    const step =
      job.job_kind === "search"
        ? await runPrismaInsightsSearchStep(active.client, provider, {
            maxItems,
            maxRequests: Math.max(8, input.maxRequests),
            jobId,
          })
        : await runPrismaInsightsReportStep(active.client, provider, {
            maxItems,
            maxRequests: Math.max(16, input.maxRequests),
            jobId,
          });
    if (step.jobId !== null && step.jobId !== jobId) {
      throw new Error("Prisma Insights worker selected another job");
    }
    const current = await readJob(active.client, provider, jobId);
    if (current?.state === "ready") {
      completed.add(jobId);
      result = { state: "complete", publicationId: jobId };
    } else if (current?.state === "failed") {
      result = { state: "failed", jobId };
    } else if (step.processed > 0) {
      result = { state: "running", jobId };
    } else {
      result = { state: "idle", jobId };
    }
    processed = step.processed;
  });
  return {
    ...result!,
    usage: { items: processed, requests: active.meter.lastRequests },
  } as InsightsMaintenanceStepResult;
};

export const createPrismaInsightsConformanceFixture = (
  options: PrismaInsightsConformanceOptions,
): PrismaInsightsConformanceFixture => {
  const activeHarnesses = new Set<{
    readonly namespaces: readonly [ActiveNamespace, ActiveNamespace];
    readonly pendingExpiry: Set<string>;
  }>();
  const budgets = { ...defaultBudgets, ...options.budgets };

  const createHarness = async (
    namespaces: InsightsModelConformanceNamespaces,
  ): Promise<InsightsModelConformanceHarness> => {
    const primary = await activateNamespace(
      await options.createNamespace(),
      options.provider,
      namespaces.insightsDatabaseNamespace,
    );
    let other: ActiveNamespace;
    try {
      other = await activateNamespace(
        await options.createNamespace(),
        options.provider,
        namespaces.otherInsightsDatabaseNamespace,
      );
    } catch (error) {
      await primary.namespace.dispose();
      throw error;
    }
    const completed = new Set<string>();
    const otherCompleted = new Set<string>();
    const pendingExpiry = new Set<string>();
    const runtime = {
      namespaces: [primary, other] as const,
      pendingExpiry,
    };
    activeHarnesses.add(runtime);

    const applyExpiry = async (): Promise<void> => {
      for (const publicationId of pendingExpiry) {
        await deletePublication(
          primary.client,
          options.provider,
          publicationId,
        );
        pendingExpiry.delete(publicationId);
        completed.delete(publicationId);
      }
    };

    const createFacade = (): InsightsModelConformanceHarness => ({
      model: instrumentModel(
        createPrismaInsightsModel(
          primary.client,
          options.provider,
          primary.databaseNamespace,
        ),
        primary.meter,
        applyExpiry,
      ),
      otherNamespaceModel: instrumentModel(
        createPrismaInsightsModel(
          other.client,
          options.provider,
          other.databaseNamespace,
        ),
        other.meter,
        () => Promise.resolve(),
      ),
      async runJobStep(jobId, input) {
        await applyExpiry();
        return runMeasuredJobStep(
          primary,
          options.provider,
          completed,
          jobId,
          input,
        );
      },
      runOtherNamespaceJobStep: (jobId, input) =>
        runMeasuredJobStep(
          other,
          options.provider,
          otherCompleted,
          jobId,
          input,
        ),
      async reopen() {
        await applyExpiry();
        await reopenNamespace(primary, options.provider);
        await reopenNamespace(other, options.provider);
        return createFacade();
      },
      async insertMigrationPoisonRow() {
        await applyExpiry();
        await insertPoison(primary.client, options.provider);
      },
      setCurrentTimeMs(nowMs) {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          throw new Error("invalid time");
        }
        primary.controls.nowMs = nowMs;
        other.controls.nowMs = nowMs;
      },
      expirePublication(publicationId) {
        pendingExpiry.add(publicationId);
        completed.delete(publicationId);
      },
      publicationStateForJob(jobId) {
        return completed.has(jobId) ? "complete" : "absent";
      },
      getLastStorageReadCount(namespace = "primary") {
        return namespace === "primary"
          ? primary.meter.lastCandidateRows
          : other.meter.lastCandidateRows;
      },
      getPageEventsCandidateReadBudget(input) {
        return budgets.pageEvents(input);
      },
      getPageInstallationsCandidateReadBudget(input) {
        return budgets.pageInstallations(input);
      },
      getPageReportCandidateReadBudget(input) {
        return budgets.pageReport(input);
      },
    });

    return createFacade();
  };

  return {
    createHarness,
    async dispose() {
      const harnesses = [...activeHarnesses];
      activeHarnesses.clear();
      await Promise.all(
        harnesses.flatMap(({ namespaces }) =>
          namespaces.map(({ namespace }) => namespace.dispose()),
        ),
      );
    },
  };
};
