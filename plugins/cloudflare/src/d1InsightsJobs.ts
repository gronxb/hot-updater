import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  createUUIDv7,
  type BundleEventRow,
  type InsightsCommittedReadVersions,
  type InsightsProjectedReadVersions,
  type InsightsSourceReadVersions,
  type InsightsPublication,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReadFailure,
  type InsightsReadVersions,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  assertInsightsEventContract,
  assertInsightsMaintenanceInputContract,
  canonicalInsightsJson,
  createInsightsReportProjection,
  getCanonicalInsightsJsonByteLength,
  isCanonicalInsightsEventId,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor, D1Statement } from "./d1Implementation";
import {
  D1InsightsMigrationPoisonError,
  D1_INSIGHTS_INSTALLATION_ALIASES,
  D1_INSIGHTS_INSTALLATION_VERSIONS,
  assertD1InsightsDatabaseNamespace,
  assertD1InsightsReady,
  d1InsightsInstallKey,
  readD1InsightsPointerEvents,
  verifyD1InsightsDatabaseNamespace,
  type D1InsightsEventPointer,
} from "./d1InsightsSource";
import { encodeD1Values, normalizeD1SchemaSql } from "./d1Sql";

const HEADS = "private_hot_updater_insights_job_heads";
const JOBS = "private_hot_updater_insights_jobs";
const LATEST = "private_hot_updater_insights_job_latest";
const MEMBERSHIPS = "private_hot_updater_insights_job_memberships";
const COUNTS = "private_hot_updater_insights_job_counts";
const ORDER = "private_hot_updater_insights_job_order";
const PAGE_ROWS = "private_hot_updater_insights_job_page_rows";
const SECTIONS = "private_hot_updater_insights_job_sections";
const SOURCE_EVENTS = "private_hot_updater_insights_source_events";
const SOURCE_STATE = "private_hot_updater_insights_source_state";
const STORAGE_REVISION = 3;
const STORAGE_VERSION = "d1-insights-v3";
const SCHEMA_VERSION = "3";
const LEASE_MS = 30_000;
const MAX_D1_REQUESTS = 50;
const MAX_STEP_EVENTS = 100;
// A report may serialize each source event twice into one D1 bind value, and
// JSON string escaping can double the canonical payload again.
const MAX_SOURCE_PROJECTION_EVENT_BYTES = 400_000;
const MAX_BUCKETS = 30;
const MAX_SAFE_COUNT = 9_007_199_254_740_991;
const INSTALL_KEY = /^[0-9a-f]{64}$/;
const QUERY_KEY = /^[0-9a-f]{64}$/;
const textEncoder = new TextEncoder();

export type D1InsightsSearchQuery =
  | { readonly kind: "installationContains"; readonly normalizedQuery: string }
  | { readonly kind: "installationUserId"; readonly userId: string };
type SearchQuery = D1InsightsSearchQuery;
type PrivateQuery = InsightsReportQuery | SearchQuery;
type JobKind = "search" | "report";
type JobStatus = "queued" | "preparing" | "ready" | "failed";

type OrderTask = {
  readonly section:
    | "movementCohorts"
    | "bundleDistribution"
    | "activeBundleTotals";
  readonly metric: "" | "installed" | "recovered";
};

type SeriesTask = {
  readonly section: "movementSeries" | "activeSeries";
  readonly metric: "" | "installed" | "recovered";
};

type JobCheckpoint =
  | { readonly phase: "source"; readonly afterGeneration: number }
  | { readonly phase: "aliases"; readonly afterAliasId: number }
  | { readonly phase: "searchLatest"; readonly afterInstallKey: string | null }
  | { readonly phase: "installations"; readonly afterInstallKey: string | null }
  | {
      readonly phase: "order";
      readonly task: number;
      readonly afterCountKey: string | null;
    }
  | {
      readonly phase: "rows";
      readonly task: number;
      readonly afterOrderKey: string | null;
      readonly nextOrdinal: number;
    }
  | {
      readonly phase: "series";
      readonly task: number;
      readonly nextBucketMs: number | null;
      readonly nextOrdinal: number;
    }
  | { readonly phase: "complete" };

export type D1InsightsStoredJob = {
  readonly id: string;
  readonly queryKey: string;
  readonly query: PrivateQuery;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly asOfMs: number;
  readonly sourceId: string;
  readonly sourceGeneration: number;
  readonly sourceAliasUpperId: number;
  readonly checkpoint: JobCheckpoint;
  readonly leaseEpoch: number;
  readonly revision: number;
  readonly publication: unknown | null;
  readonly resultTotal: number | null;
  readonly failureCode: "preparation-failed" | "migration-poison" | null;
};
type StoredJob = D1InsightsStoredJob;

export type D1InsightsPrivatePublication = InsightsPublication & {
  readonly total: number;
};

export type D1InsightsJobResult<TPublication> =
  | { readonly state: "ready"; readonly publication: TPublication }
  | {
      readonly state: "queued" | "preparing";
      readonly jobId: string;
      readonly previous: TPublication | null;
    }
  | {
      readonly state: "failed";
      readonly error: Extract<InsightsReadFailure, { readonly jobId: string }>;
      readonly previous: TPublication | null;
    };

export type D1InsightsMaintenanceResult = {
  readonly state:
    | "idle"
    | "progress"
    | "published"
    | "not-ready"
    | "lease-lost"
    | "failed";
  readonly processed: number;
  readonly requests: number;
  readonly jobId?: string;
  readonly error?: {
    readonly code: "migration-poison";
    readonly jobId: string;
  };
};

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const isProvenJobCorruption = (error: unknown): boolean =>
  (error instanceof DatabasePluginInputError &&
    error.code === "invalid-result") ||
  (error instanceof Error &&
    /HOT_UPDATER_INSIGHTS_(?:JOB_(?:INSTALL_KEY|COUNT)_COLLISION|PUBLICATION_NOT_ATOMIC)/.test(
      error.message,
    ));

const isProvenPublicationInvariantFailure = (
  error: unknown,
  job: StoredJob,
): boolean =>
  job.checkpoint.phase === "complete" &&
  error instanceof Error &&
  /malformed json/i.test(error.message);

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const only = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const digestHex = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", textEncoder.encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const jsStringOrderKey = (value: string): string => {
  let saved = "";
  for (let index = 0; index < value.length; index += 1) {
    saved += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `${saved}!`;
};

const countIdentity = (
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): string => canonicalInsightsJson([section, metric, label, bucketStartMs]);

const sectionKey = (section: string, metric = ""): string =>
  canonicalInsightsJson([section, metric]);

const sourceGeneration = (
  job: Pick<StoredJob, "sourceId" | "sourceGeneration">,
) => JSON.stringify([2, job.sourceId, job.sourceGeneration]);

export function d1InsightsJobVersions(
  generation: string,
  projectionGeneration: null,
): InsightsSourceReadVersions;
export function d1InsightsJobVersions(
  generation: string,
  projectionGeneration: string,
): InsightsProjectedReadVersions;
export function d1InsightsJobVersions(
  generation: string,
  projectionGeneration: string | null,
): InsightsCommittedReadVersions {
  return {
    schemaVersion: SCHEMA_VERSION,
    storageVersion: STORAGE_VERSION,
    projectionGeneration,
    sourceGeneration: generation,
  };
}

const unavailableVersions: InsightsReadVersions = {
  schemaVersion: null,
  storageVersion: null,
  projectionGeneration: null,
  sourceGeneration: null,
};

export const d1InsightsUnavailableVersions = (): InsightsReadVersions => ({
  ...unavailableVersions,
});

const searchIdentity = (query: SearchQuery) =>
  query.kind === "installationContains"
    ? JSON.stringify([1, query.kind, query.normalizedQuery])
    : JSON.stringify([1, query.kind, query.userId]);

const privateQueryIdentity = async (query: PrivateQuery) => {
  const parsed =
    query.kind === "installationContains"
      ? (() => {
          if (
            !only(query, ["kind", "normalizedQuery"]) ||
            typeof query.normalizedQuery !== "string" ||
            query.normalizedQuery.length === 0 ||
            query.normalizedQuery !== query.normalizedQuery.toLowerCase()
          ) {
            invalidQuery();
          }
          return { query, semanticKey: searchIdentity(query) };
        })()
      : query.kind === "installationUserId"
        ? (() => {
            if (
              !only(query, ["kind", "userId"]) ||
              typeof query.userId !== "string"
            ) {
              invalidQuery();
            }
            return { query, semanticKey: searchIdentity(query) };
          })()
        : readInsightsReportQuery({ query });
  const queryJson = canonicalInsightsJson(parsed.query);
  return {
    query: parsed.query,
    queryJson,
    semanticKey: parsed.semanticKey,
    queryKey: await digestHex(
      canonicalInsightsJson([STORAGE_REVISION, parsed.semanticKey]),
    ),
  };
};

const parsePrivateQuery = async (
  value: unknown,
  expectedKey: string,
): Promise<PrivateQuery> => {
  if (!record(value) || typeof value.kind !== "string") return invalidResult();
  const query = value as unknown as PrivateQuery;
  let identity: Awaited<ReturnType<typeof privateQueryIdentity>>;
  try {
    identity = await privateQueryIdentity(query);
  } catch {
    return invalidResult();
  }
  if (identity.queryKey !== expectedKey) return invalidResult();
  return identity.query;
};

const parseCheckpoint = (value: unknown): JobCheckpoint => {
  if (!record(value) || typeof value.phase !== "string") return invalidResult();
  switch (value.phase) {
    case "source":
      if (
        only(value, ["phase", "afterGeneration"]) &&
        safeInteger(value.afterGeneration)
      ) {
        return { phase: value.phase, afterGeneration: value.afterGeneration };
      }
      break;
    case "aliases":
      if (
        only(value, ["phase", "afterAliasId"]) &&
        safeInteger(value.afterAliasId)
      ) {
        return { phase: value.phase, afterAliasId: value.afterAliasId };
      }
      break;
    case "searchLatest":
      if (
        only(value, ["phase", "afterInstallKey"]) &&
        (value.afterInstallKey === null ||
          INSTALL_KEY.test(String(value.afterInstallKey)))
      ) {
        return {
          phase: value.phase,
          afterInstallKey: value.afterInstallKey as string | null,
        };
      }
      break;
    case "installations":
      if (
        only(value, ["phase", "afterInstallKey"]) &&
        (value.afterInstallKey === null ||
          INSTALL_KEY.test(String(value.afterInstallKey)))
      ) {
        return {
          phase: value.phase,
          afterInstallKey: value.afterInstallKey as string | null,
        };
      }
      break;
    case "order":
      if (
        only(value, ["phase", "task", "afterCountKey"]) &&
        safeInteger(value.task) &&
        (value.afterCountKey === null ||
          typeof value.afterCountKey === "string")
      ) {
        return {
          phase: value.phase,
          task: value.task,
          afterCountKey: value.afterCountKey,
        };
      }
      break;
    case "rows":
      if (
        only(value, ["phase", "task", "afterOrderKey", "nextOrdinal"]) &&
        safeInteger(value.task) &&
        safeInteger(value.nextOrdinal) &&
        (value.afterOrderKey === null ||
          typeof value.afterOrderKey === "string")
      ) {
        return {
          phase: value.phase,
          task: value.task,
          afterOrderKey: value.afterOrderKey,
          nextOrdinal: value.nextOrdinal,
        };
      }
      break;
    case "series":
      if (
        only(value, ["phase", "task", "nextBucketMs", "nextOrdinal"]) &&
        safeInteger(value.task) &&
        safeInteger(value.nextOrdinal) &&
        (value.nextBucketMs === null || safeInteger(value.nextBucketMs))
      ) {
        return {
          phase: value.phase,
          task: value.task,
          nextBucketMs: value.nextBucketMs,
          nextOrdinal: value.nextOrdinal,
        };
      }
      break;
    case "complete":
      if (only(value, ["phase"])) return { phase: value.phase };
      break;
  }
  return invalidResult();
};

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return invalidResult();
  try {
    return JSON.parse(value);
  } catch {
    return invalidResult();
  }
};

const parseJob = async (value: unknown): Promise<StoredJob> => {
  if (!record(value)) return invalidResult();
  const id = value.id;
  const queryKey = value.query_key;
  const kind = value.job_kind;
  const status = value.status;
  if (
    !isCanonicalInsightsEventId(id) ||
    typeof queryKey !== "string" ||
    !QUERY_KEY.test(queryKey) ||
    (kind !== "search" && kind !== "report") ||
    !["queued", "preparing", "ready", "failed"].includes(String(status)) ||
    !safeInteger(value.as_of_ms) ||
    typeof value.source_id !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.source_id) ||
    !safeInteger(value.source_generation) ||
    !safeInteger(value.source_alias_upper_id) ||
    !safeInteger(value.lease_epoch) ||
    !safeInteger(value.revision) ||
    !(value.result_total === null || safeInteger(value.result_total)) ||
    (status === "failed"
      ? value.failure_code !== "preparation-failed" &&
        value.failure_code !== "migration-poison"
      : value.failure_code !== null)
  ) {
    return invalidResult();
  }
  const query = await parsePrivateQuery(parseJson(value.query_json), queryKey);
  if (
    (kind === "search") !==
    (query.kind === "installationContains" ||
      query.kind === "installationUserId")
  ) {
    return invalidResult();
  }
  return {
    id,
    queryKey,
    query,
    kind,
    status: status as JobStatus,
    asOfMs: value.as_of_ms,
    sourceId: value.source_id,
    sourceGeneration: value.source_generation,
    sourceAliasUpperId: value.source_alias_upper_id,
    checkpoint: parseCheckpoint(parseJson(value.checkpoint_json)),
    leaseEpoch: value.lease_epoch,
    revision: value.revision,
    publication:
      value.publication_json === null
        ? null
        : parseJson(value.publication_json),
    resultTotal: value.result_total as number | null,
    failureCode: value.failure_code as StoredJob["failureCode"],
  };
};

const jobSelect = `id, query_key, query_json, job_kind, status, as_of_ms,
  source_id, source_generation, source_alias_upper_id, checkpoint_json,
  lease_epoch, revision,
  publication_json, result_total, failure_code`;

const JOB_SCHEMA_HASHES: Readonly<Record<string, string>> = {
  insights_job_latest_install_key_collision:
    "fa454765d2fd567545b4122c01f145f4fa500d4b018f80f1ac265f7ac38db600",
  insights_job_membership_count:
    "2da62e61b835b101fdcfbd4403b44fc9284ba2e58d7e72e33e9c6699ef43449d",
  insights_job_membership_count_collision:
    "61ae40d0ba50050d6aae1b64a2c6cfe6915dc2d4345f4e86b5b97cf0dbce9086",
  insights_job_membership_install_key_collision:
    "70ee5cbad6e1e2a242a07cf63318cbab14eab615f8e03317c3408600ac8e5701",
  private_hot_updater_insights_job_claim_idx:
    "f9fecbe750483e6ac2c696af3aafec1fb73f3c120dcdda00f41d873374bad946",
  private_hot_updater_insights_job_count_order_idx:
    "23ea425cac859b4e6fcdbdd2919631e4e26ea92005bdb5a14c1bfc6cdc881e34",
  private_hot_updater_insights_job_count_series_idx:
    "6c7ee68f3924212b013bf5259c0ce549cea921185525337a96a89ad4c85160cf",
  private_hot_updater_insights_job_counts:
    "29700b28422164dbc8cc9dd20f72834c0bb2c52ccc0233a5b498dbca229058db",
  private_hot_updater_insights_job_head_active_idx:
    "c6b0ec71e0f55c5141098a37b5a5c5bc1af19ce86ef1441f7eef598b688f7d13",
  private_hot_updater_insights_job_heads:
    "2ad38d9d745514ad80247fb6b243a54ebaaa63e9362e705cbf1021a36759da48",
  private_hot_updater_insights_job_latest:
    "259a3adef715a9d049315cc1795fa070d814fffe034947d45f107496fed73a23",
  private_hot_updater_insights_job_latest_scan_idx:
    "ae8daf8aa2e13f9a4baa75af075459fb85309eab42de3dba6878587b323a2664",
  private_hot_updater_insights_job_lease_idx:
    "3459ef35659002590c9d9bdc892599beff180c18554dd7cad30e7b0f2839143f",
  private_hot_updater_insights_job_memberships:
    "8fcc1093a964ac0cb54d1b0b2b9d7bedcf878ff080f0874cf97ef2b3fdada358",
  private_hot_updater_insights_job_order:
    "ae1a75fabb3284fa61b53638a86daf031d81364d68f5b9181e6910eed8812c99",
  private_hot_updater_insights_job_page_filter_idx:
    "ee11f2c887cbdc02a135d44e2b7efff641703d64e0c229f82fb5bcfe1a99f59d",
  private_hot_updater_insights_job_page_rows:
    "d91e0415ee6785f122d7826167c091dd0b2e49e3ee0ed6b17dac8fbf00f92216",
  private_hot_updater_insights_job_query_idx:
    "832651d83cf3e2ad6e131b407a3a3fe927823ab6dca6ac2056b6877eeb55701f",
  private_hot_updater_insights_job_sections:
    "b85407f9bb34bc00bd34e1bb8115adb262eaeef8e11f2951544ecfa8510f2bf0",
  private_hot_updater_insights_jobs:
    "079242c9bfeea269fa48db386591abb2a648abd6fa673e462723a24ab57c676a",
};

export const assertD1InsightsJobsLayout = async (
  executor: D1Executor,
): Promise<void> => {
  const rows = await executor.query(
    `SELECT name, type, sql FROM sqlite_master
    WHERE name IN (${Object.keys(JOB_SCHEMA_HASHES)
      .map(() => "?")
      .join(", ")})
    ORDER BY name COLLATE BINARY ASC`,
    Object.keys(JOB_SCHEMA_HASHES),
  );
  if (rows.length !== Object.keys(JOB_SCHEMA_HASHES).length) {
    throw new InsightsQueryNotReadyError();
  }
  const actual = new Map<string, string>();
  for (const row of rows) {
    if (
      !record(row) ||
      typeof row.name !== "string" ||
      typeof row.type !== "string" ||
      typeof row.sql !== "string" ||
      actual.has(row.name) ||
      !(row.name in JOB_SCHEMA_HASHES) ||
      !["table", "index", "trigger"].includes(row.type)
    ) {
      throw new InsightsQueryNotReadyError();
    }
    actual.set(row.name, await digestHex(normalizeD1SchemaSql(row.sql)));
  }
  if (
    Object.entries(JOB_SCHEMA_HASHES).some(
      ([name, expected]) => actual.get(name) !== expected,
    )
  ) {
    throw new InsightsQueryNotReadyError();
  }
};

const publicationBase = (
  value: unknown,
  job: StoredJob,
): InsightsPublication => {
  if (
    !record(value) ||
    value.id !== job.id ||
    value.asOfMs !== job.asOfMs ||
    !safeInteger(value.completedAtMs) ||
    value.sourceGeneration !== sourceGeneration(job) ||
    value.accuracy !== "exact"
  ) {
    return invalidResult();
  }
  return {
    id: value.id,
    asOfMs: value.asOfMs,
    completedAtMs: value.completedAtMs,
    sourceGeneration: value.sourceGeneration,
    accuracy: value.accuracy,
  };
};

const searchPublication = (job: StoredJob): D1InsightsPrivatePublication => {
  if (job.kind !== "search" || job.status !== "ready") return invalidResult();
  const base = publicationBase(job.publication, job);
  if (
    !record(job.publication) ||
    !safeInteger(job.publication.total) ||
    job.publication.total !== job.resultTotal
  ) {
    return invalidResult();
  }
  return { ...base, total: job.publication.total };
};

const summaryCount = (value: unknown): number =>
  safeInteger(value) ? value : invalidResult();

const reportPublication = (job: StoredJob): InsightsReportPublication => {
  if (job.kind !== "report" || job.status !== "ready") return invalidResult();
  const base = publicationBase(job.publication, job);
  if (!record(job.publication) || job.publication.kind !== job.query.kind) {
    return invalidResult();
  }
  const summary = job.publication.summary;
  switch (job.query.kind) {
    case "bundleSummaries": {
      const bundleIds = job.query.bundleIds;
      if (!Array.isArray(summary) || summary.length !== bundleIds.length) {
        return invalidResult();
      }
      const saved = summary.map((value, index) => {
        if (
          !record(value) ||
          typeof value.bundleId !== "string" ||
          value.bundleId !== bundleIds[index]
        ) {
          return invalidResult();
        }
        return {
          bundleId: value.bundleId,
          installed: summaryCount(value.installed),
          recovered: summaryCount(value.recovered),
        };
      });
      return { ...base, kind: job.query.kind, summary: saved };
    }
    case "bundleDetail":
      if (!record(summary)) return invalidResult();
      return {
        ...base,
        kind: job.query.kind,
        summary: {
          installed: summaryCount(summary.installed),
          recovered: summaryCount(summary.recovered),
        },
      };
    case "installationOverview":
      if (!record(summary)) return invalidResult();
      return {
        ...base,
        kind: job.query.kind,
        summary: {
          trackedInstallations: summaryCount(summary.trackedInstallations),
        },
      };
    case "activeOverview":
      if (!record(summary)) return invalidResult();
      return {
        ...base,
        kind: job.query.kind,
        summary: {
          activeInstallations: summaryCount(summary.activeInstallations),
        },
      };
    default:
      return invalidResult();
  }
};

type StoredHead = {
  readonly active: StoredJob | null;
  readonly publication: StoredJob | null;
};

const readHead = async (
  executor: D1Executor,
  identity: Awaited<ReturnType<typeof privateQueryIdentity>>,
): Promise<StoredHead | null> => {
  const rows = await executor.query(
    `SELECT query_json, active_job_id, publication_job_id
    FROM ${HEADS} WHERE query_key = json_extract(?, '$') COLLATE BINARY
    LIMIT 1`,
    encodeD1Values([identity.queryKey]),
  );
  if (rows.length === 0) return null;
  const head = rows[0];
  if (
    rows.length !== 1 ||
    !record(head) ||
    head.query_json !== identity.queryJson ||
    !(
      head.active_job_id === null ||
      isCanonicalInsightsEventId(head.active_job_id)
    ) ||
    !(
      head.publication_job_id === null ||
      isCanonicalInsightsEventId(head.publication_job_id)
    )
  ) {
    return invalidResult();
  }
  const ids = [head.active_job_id, head.publication_job_id].filter(
    (value): value is string => value !== null,
  );
  if (ids.length === 0) return { active: null, publication: null };
  const saved = await executor.query(
    `SELECT ${jobSelect} FROM ${JOBS}
    WHERE id IN (SELECT value FROM json_each(?)) LIMIT 2`,
    [JSON.stringify(ids)],
  );
  if (saved.length !== new Set(ids).size) return invalidResult();
  const jobs = await Promise.all(saved.map(parseJob));
  if (jobs.some((job) => job.queryKey !== identity.queryKey)) {
    return invalidResult();
  }
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const active =
    head.active_job_id === null
      ? null
      : (byId.get(head.active_job_id) ?? invalidResult());
  const publication =
    head.publication_job_id === null
      ? null
      : (byId.get(head.publication_job_id) ?? invalidResult());
  if (publication !== null && publication.status !== "ready") {
    return invalidResult();
  }
  if (active !== null && active.status === "ready") return invalidResult();
  return { active, publication };
};

const currentD1Time = async (executor: D1Executor): Promise<number> => {
  const rows = await executor.query(
    `SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS now_ms`,
    [],
  );
  const value = record(rows[0]) ? rows[0].now_ms : undefined;
  return rows.length === 1 && safeInteger(value) ? value : invalidResult();
};

const mapHeadResult = <TPublication extends InsightsPublication>(
  head: StoredHead,
  readPublication: (job: StoredJob) => TPublication,
  minAsOfMs: number | undefined,
): D1InsightsJobResult<TPublication> | null => {
  const previous =
    head.publication === null ? null : readPublication(head.publication);
  if (
    previous !== null &&
    (minAsOfMs === undefined || previous.asOfMs >= minAsOfMs)
  ) {
    return { state: "ready", publication: previous };
  }
  const active = head.active;
  if (active === null) return null;
  if (active.status === "failed") {
    return {
      state: "failed",
      error: { code: active.failureCode ?? invalidResult(), jobId: active.id },
      previous,
    };
  }
  if (active.status !== "queued" && active.status !== "preparing") {
    return invalidResult();
  }
  return { state: active.status, jobId: active.id, previous };
};

const reserve = async <TPublication extends InsightsPublication>(
  executor: D1Executor,
  query: PrivateQuery,
  minAsOfMs: number | undefined,
  readPublication: (job: StoredJob) => TPublication,
): Promise<D1InsightsJobResult<TPublication>> => {
  await assertD1InsightsJobsLayout(executor);
  const [, now, identity] = await Promise.all([
    assertD1InsightsReady(executor),
    currentD1Time(executor),
    privateQueryIdentity(query),
  ]);
  if (minAsOfMs !== undefined && minAsOfMs > now) invalidQuery();
  const existing = await readHead(executor, identity);
  if (existing !== null) {
    const result = mapHeadResult(existing, readPublication, minAsOfMs);
    if (result !== null) return result;
  }
  const id = createUUIDv7();
  const kind: JobKind =
    query.kind === "installationContains" || query.kind === "installationUserId"
      ? "search"
      : "report";
  const checkpoint: JobCheckpoint =
    query.kind === "bundleSummaries" && query.bundleIds.length === 0
      ? { phase: "complete" }
      : kind === "search"
        ? { phase: "aliases", afterAliasId: 0 }
        : { phase: "source", afterGeneration: 0 };
  const minimum = minAsOfMs ?? 0;
  await executor.batch([
    {
      sql: `INSERT INTO ${HEADS} (query_key, query_json)
        VALUES (json_extract(?, '$'), json_extract(?, '$'))
        ON CONFLICT(query_key) DO NOTHING`,
      params: encodeD1Values([identity.queryKey, identity.queryJson]),
    },
    {
      sql: `INSERT INTO ${JOBS} (
          id, query_key, query_json, job_kind, status, as_of_ms, source_id,
          source_generation, source_alias_upper_id, checkpoint_json
        )
        SELECT json_extract(?, '$'), json_extract(?, '$'),
          json_extract(?, '$'), json_extract(?, '$'), 'queued',
          json_extract(?, '$'), source.source_id, source.generation,
          COALESCE((
            SELECT max(alias_id) FROM ${D1_INSIGHTS_INSTALLATION_ALIASES}
          ), 0), json_extract(?, '$')
        FROM ${HEADS} AS head
        CROSS JOIN ${SOURCE_STATE} AS source
        WHERE head.query_key = json_extract(?, '$') COLLATE BINARY
          AND head.query_json = json_extract(?, '$')
          AND source.id = 1 AND source.version = 2 AND source.status = 'ready'
          AND head.active_job_id IS NULL
          AND (
            head.publication_job_id IS NULL OR
            COALESCE((
              SELECT as_of_ms FROM ${JOBS}
              WHERE id = head.publication_job_id AND status = 'ready'
            ), -1) < json_extract(?, '$')
          )`,
      params: encodeD1Values([
        id,
        identity.queryKey,
        identity.queryJson,
        kind,
        now,
        canonicalInsightsJson(checkpoint),
        identity.queryKey,
        identity.queryJson,
        minimum,
      ]),
    },
    {
      sql: `UPDATE ${HEADS} SET active_job_id = json_extract(?, '$')
        WHERE query_key = json_extract(?, '$') COLLATE BINARY
          AND active_job_id IS NULL
          AND EXISTS (SELECT 1 FROM ${JOBS} WHERE id = json_extract(?, '$'))`,
      params: encodeD1Values([id, identity.queryKey, id]),
    },
  ]);
  const head = await readHead(executor, identity);
  if (head === null) return invalidResult();
  const result = mapHeadResult(head, readPublication, minAsOfMs);
  return result ?? invalidResult();
};

export const reserveD1InsightsReport = async (
  executor: D1Executor,
  input: { readonly query: InsightsReportQuery; readonly minAsOfMs?: number },
): Promise<D1InsightsJobResult<InsightsReportPublication>> => {
  const parsed = readInsightsReportQuery(input);
  return reserve(executor, parsed.query, parsed.minAsOfMs, reportPublication);
};

export const reserveD1InsightsSearch = async (
  executor: D1Executor,
  input:
    | {
        readonly kind: "contains";
        readonly query: string;
        readonly minAsOfMs?: number;
      }
    | {
        readonly kind: "userId";
        readonly userId: string;
        readonly minAsOfMs?: number;
      },
): Promise<D1InsightsJobResult<D1InsightsPrivatePublication>> => {
  const query: SearchQuery =
    input.kind === "contains"
      ? {
          kind: "installationContains",
          normalizedQuery: input.query.toLowerCase(),
        }
      : { kind: "installationUserId", userId: input.userId };
  return reserve(executor, query, input.minAsOfMs, searchPublication);
};

export const readD1InsightsPublishedJob = async (
  executor: D1Executor,
  id: string,
): Promise<StoredJob | null> => {
  if (!isCanonicalInsightsEventId(id)) invalidQuery();
  await assertD1InsightsJobsLayout(executor);
  const rows = await executor.query(
    `SELECT ${jobSelect} FROM ${JOBS}
    WHERE id = json_extract(?, '$') COLLATE BINARY LIMIT 1`,
    encodeD1Values([id]),
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) return invalidResult();
  return parseJob(rows[0]);
};

export const getD1InsightsSearchPublication = (
  job: StoredJob,
): D1InsightsPrivatePublication => searchPublication(job);

export const getD1InsightsReportPublication = (
  job: StoredJob,
): InsightsReportPublication => reportPublication(job);

export const getD1InsightsStoredSourceGeneration = (
  job: D1InsightsStoredJob,
): string => sourceGeneration(job);

type Membership = {
  readonly countKey: string;
  readonly installKey: string;
  readonly installId: string;
  readonly section: string;
  readonly metric: string;
  readonly label: string;
  readonly bucketStartMs: number;
};

type Latest = {
  readonly installKey: string;
  readonly bucketIndex: number;
  readonly installId: string;
  readonly eventId: string;
  readonly receivedAtMs: number;
  readonly rowBytes: number;
  readonly eventJson: string;
};

const membership = (
  installKey: string,
  installId: string,
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): Membership => ({
  countKey: countIdentity(section, metric, label, bucketStartMs),
  installKey,
  installId,
  section,
  metric,
  label,
  bucketStartMs,
});

const latest = (
  event: BundleEventRow,
  installKey: string,
  bucketIndex: number,
): Latest => ({
  installKey,
  bucketIndex,
  installId: event.install_id,
  eventId: event.id,
  receivedAtMs: event.received_at_ms,
  rowBytes: getCanonicalInsightsJsonByteLength(event),
  eventJson: canonicalInsightsJson(event),
});

const latestStatement = (
  jobId: string,
  rows: readonly Latest[],
): D1Statement => ({
  sql: `INSERT INTO ${LATEST} (
      job_id, install_key, bucket_index, install_id, event_id,
      received_at_ms, row_bytes, event_json
    )
    SELECT json_extract(?, '$'),
      json_extract(value, '$.installKey'),
      json_extract(value, '$.bucketIndex'),
      json_extract(value, '$.installId'),
      json_extract(value, '$.eventId'),
      json_extract(value, '$.receivedAtMs'),
      json_extract(value, '$.rowBytes'),
      json_extract(value, '$.eventJson')
    FROM json_each(?) WHERE true
    ON CONFLICT(job_id, install_key, bucket_index) DO UPDATE SET
      event_id = excluded.event_id,
      received_at_ms = excluded.received_at_ms,
      row_bytes = excluded.row_bytes,
      event_json = excluded.event_json
    WHERE ${LATEST}.install_id = excluded.install_id
      AND (${LATEST}.received_at_ms < excluded.received_at_ms
        OR (${LATEST}.received_at_ms = excluded.received_at_ms
          AND ${LATEST}.event_id < excluded.event_id))`,
  params: [JSON.stringify(jobId), JSON.stringify(rows)],
});

const membershipStatement = (
  jobId: string,
  rows: readonly Membership[],
): D1Statement => ({
  sql: `INSERT OR IGNORE INTO ${MEMBERSHIPS} (
      job_id, count_key, install_key, install_id, section, metric, label,
      bucket_start_ms
    )
    SELECT json_extract(?, '$'),
      json_extract(value, '$.countKey'),
      json_extract(value, '$.installKey'),
      json_extract(value, '$.installId'),
      json_extract(value, '$.section'),
      json_extract(value, '$.metric'),
      json_extract(value, '$.label'),
      json_extract(value, '$.bucketStartMs')
    FROM json_each(?)`,
  params: [JSON.stringify(jobId), JSON.stringify(rows)],
});

const leaseGuard = (job: StoredJob): D1Statement => ({
  sql: `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM ${JOBS} AS job
      JOIN ${HEADS} AS head ON head.query_key = job.query_key
      WHERE job.id = json_extract(?, '$') COLLATE BINARY
        AND job.status = 'preparing'
        AND job.lease_epoch = json_extract(?, '$')
        AND job.revision = json_extract(?, '$')
        AND job.lease_until_ms >
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
        AND head.active_job_id = job.id
    ) THEN 1 ELSE json_extract('HOT_UPDATER_INSIGHTS_JOB_LEASE_LOST', '$')
    END AS lease_guard`,
  params: encodeD1Values([job.id, job.leaseEpoch, job.revision]),
});

const checkpointStatement = (
  job: StoredJob,
  checkpoint: JobCheckpoint,
): D1Statement => ({
  sql: `UPDATE ${JOBS} SET status = 'queued',
      checkpoint_json = json_extract(?, '$'), lease_until_ms = 0,
      claimable_at_ms = 0, revision = revision + 1
    WHERE id = json_extract(?, '$') COLLATE BINARY
      AND status = 'preparing' AND lease_epoch = json_extract(?, '$')
      AND revision = json_extract(?, '$')
    RETURNING revision`,
  params: encodeD1Values([
    canonicalInsightsJson(checkpoint),
    job.id,
    job.leaseEpoch,
    job.revision,
  ]),
});

const readJobRevision = async (
  executor: D1Executor,
  jobId: string,
): Promise<{
  status: JobStatus;
  revision: number;
  leaseEpoch: number;
} | null> => {
  const rows = await executor.query(
    `SELECT status, revision, lease_epoch FROM ${JOBS}
    WHERE id = json_extract(?, '$') COLLATE BINARY LIMIT 1`,
    encodeD1Values([jobId]),
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !record(row) ||
    !["queued", "preparing", "ready", "failed"].includes(String(row.status)) ||
    !safeInteger(row.revision) ||
    !safeInteger(row.lease_epoch)
  ) {
    return invalidResult();
  }
  return {
    status: row.status as JobStatus,
    revision: row.revision,
    leaseEpoch: row.lease_epoch,
  };
};

const commitLeased = async (
  executor: D1Executor,
  job: StoredJob,
  statements: readonly D1Statement[],
): Promise<"committed" | "lease-lost"> => {
  const targetRevision = job.revision + 1;
  try {
    const results = await executor.batch(statements);
    const marker = results.at(-1);
    if (
      marker?.length !== 1 ||
      !record(marker[0]) ||
      marker[0].revision !== targetRevision
    ) {
      return invalidResult();
    }
    return "committed";
  } catch (error) {
    const stored = await readJobRevision(executor, job.id);
    if (stored?.revision === targetRevision) return "committed";
    if (
      stored === null ||
      stored.leaseEpoch !== job.leaseEpoch ||
      stored.status !== "preparing"
    ) {
      return "lease-lost";
    }
    throw error;
  }
};

const orderTasks = (query: PrivateQuery): readonly OrderTask[] => {
  switch (query.kind) {
    case "bundleDetail":
      return [
        { section: "movementCohorts", metric: "installed" },
        { section: "movementCohorts", metric: "recovered" },
      ];
    case "installationOverview":
      return [{ section: "bundleDistribution", metric: "" }];
    case "activeOverview":
      return [
        { section: "bundleDistribution", metric: "" },
        { section: "activeBundleTotals", metric: "" },
      ];
    default:
      return [];
  }
};

const seriesTasks = (query: PrivateQuery): readonly SeriesTask[] => {
  switch (query.kind) {
    case "bundleDetail":
      return [
        { section: "movementSeries", metric: "installed" },
        { section: "movementSeries", metric: "recovered" },
      ];
    case "activeOverview":
      return [{ section: "activeSeries", metric: "" }];
    default:
      return [];
  }
};

const firstAfterSource = (query: PrivateQuery): JobCheckpoint => {
  if (query.kind === "bundleSummaries") {
    return { phase: "complete" };
  }
  if (
    query.kind === "installationOverview" ||
    query.kind === "activeOverview"
  ) {
    return { phase: "installations", afterInstallKey: null };
  }
  return { phase: "order", task: 0, afterCountKey: null };
};

const afterInstallations = (query: PrivateQuery): JobCheckpoint =>
  orderTasks(query).length > 0
    ? { phase: "order", task: 0, afterCountKey: null }
    : seriesTasks(query).length > 0
      ? { phase: "series", task: 0, nextBucketMs: null, nextOrdinal: 0 }
      : { phase: "complete" };

const afterOrdering = (query: PrivateQuery): JobCheckpoint =>
  orderTasks(query).length > 0
    ? { phase: "rows", task: 0, afterOrderKey: null, nextOrdinal: 0 }
    : seriesTasks(query).length > 0
      ? { phase: "series", task: 0, nextBucketMs: null, nextOrdinal: 0 }
      : { phase: "complete" };

const afterRows = (query: PrivateQuery): JobCheckpoint =>
  seriesTasks(query).length > 0
    ? { phase: "series", task: 0, nextBucketMs: null, nextOrdinal: 0 }
    : { phase: "complete" };

const stepAliases = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (job.kind !== "search" || job.checkpoint.phase !== "aliases") {
    return invalidResult();
  }
  const query = job.query as SearchQuery;
  const limit = Math.min(100, Math.max(1, input.maxItems - 8));
  const exact = query.kind === "installationUserId";
  const rows = await executor.query(
    `SELECT alias_id, install_key, install_id, alias_kind, alias_value,
      folded_value, first_generation
    FROM ${D1_INSIGHTS_INSTALLATION_ALIASES}
      ${exact ? "INDEXED BY private_hot_updater_insights_alias_exact_idx" : ""}
    WHERE ${exact ? "alias_kind = 'userId' AND alias_value = json_extract(?, '$') COLLATE BINARY AND" : ""}
      alias_id > json_extract(?, '$')
      AND alias_id <= json_extract(?, '$')
      ${exact ? "" : "AND instr(folded_value, json_extract(?, '$')) > 0"}
    ORDER BY alias_id ASC LIMIT json_extract(?, '$')`,
    encodeD1Values([
      ...(exact ? [query.userId] : []),
      job.checkpoint.afterAliasId,
      job.sourceAliasUpperId,
      ...(exact ? [] : [query.normalizedQuery]),
      limit,
    ]),
  );
  if (rows.length > limit) return invalidResult();
  let previous = job.checkpoint.afterAliasId;
  const memberships: Membership[] = [];
  for (const row of rows) {
    if (
      !record(row) ||
      !safeInteger(row.alias_id) ||
      row.alias_id <= previous ||
      row.alias_id > job.sourceAliasUpperId ||
      typeof row.install_key !== "string" ||
      !INSTALL_KEY.test(row.install_key) ||
      typeof row.install_id !== "string" ||
      !["installId", "userId", "username"].includes(String(row.alias_kind)) ||
      typeof row.alias_value !== "string" ||
      typeof row.folded_value !== "string" ||
      row.folded_value !== row.alias_value.toLowerCase() ||
      !safeInteger(row.first_generation) ||
      row.first_generation < 1 ||
      row.first_generation > job.sourceGeneration ||
      (exact
        ? row.alias_kind !== "userId" || row.alias_value !== query.userId
        : !row.folded_value.includes(query.normalizedQuery))
    ) {
      return invalidResult();
    }
    previous = row.alias_id;
    memberships.push(
      membership(row.install_key, row.install_id, "search", "", "", -1),
    );
  }
  const exhausted = rows.length < limit || previous === job.sourceAliasUpperId;
  const checkpoint: JobCheckpoint = exhausted
    ? { phase: "searchLatest", afterInstallKey: null }
    : { phase: "aliases", afterAliasId: previous };
  const writes =
    memberships.length === 0 ? [] : [membershipStatement(job.id, memberships)];
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { rows, memberships, checkpoint },
  );
  return { processed: rows.length, leaseLost: committed === "lease-lost" };
};

type SearchLatestPointer = D1InsightsEventPointer & {
  readonly installKey: string;
  readonly installId: string;
  readonly versionGeneration: number;
};

const stepSearchLatest = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (job.kind !== "search" || job.checkpoint.phase !== "searchLatest") {
    return invalidResult();
  }
  const limit = Math.min(100, Math.max(1, input.maxItems - 12));
  const rows = await executor.query(
    `SELECT membership.install_key, membership.install_id,
      version.generation AS version_generation, version.event_id,
      version.received_at_ms, version.row_bytes
    FROM ${MEMBERSHIPS} AS membership
    JOIN ${D1_INSIGHTS_INSTALLATION_VERSIONS} AS version
      ON version.install_key = membership.install_key
      AND version.generation = (
        SELECT max(candidate.generation)
        FROM ${D1_INSIGHTS_INSTALLATION_VERSIONS} AS candidate
        WHERE candidate.install_key = membership.install_key
          AND candidate.generation <= json_extract(?, '$')
      )
    WHERE membership.job_id = json_extract(?, '$') COLLATE BINARY
      AND membership.count_key = json_extract(?, '$')
      ${
        job.checkpoint.afterInstallKey === null
          ? ""
          : "AND membership.install_key > json_extract(?, '$') COLLATE BINARY"
      }
    ORDER BY membership.install_key COLLATE BINARY ASC
    LIMIT json_extract(?, '$')`,
    encodeD1Values([
      job.sourceGeneration,
      job.id,
      countIdentity("search", "", "", -1),
      ...(job.checkpoint.afterInstallKey === null
        ? []
        : [job.checkpoint.afterInstallKey]),
      limit,
    ]),
  );
  if (rows.length > limit) return invalidResult();
  let previous = job.checkpoint.afterInstallKey;
  const pointers = rows.map((row): SearchLatestPointer => {
    if (
      !record(row) ||
      typeof row.install_key !== "string" ||
      !INSTALL_KEY.test(row.install_key) ||
      (previous !== null && row.install_key <= previous) ||
      typeof row.install_id !== "string" ||
      !safeInteger(row.version_generation) ||
      row.version_generation < 1 ||
      row.version_generation > job.sourceGeneration ||
      !isCanonicalInsightsEventId(row.event_id) ||
      !safeInteger(row.received_at_ms) ||
      !safeInteger(row.row_bytes) ||
      row.row_bytes < 1 ||
      row.row_bytes > INSIGHTS_EVENT_MAX_BYTES
    ) {
      return invalidResult();
    }
    previous = row.install_key;
    return {
      installKey: row.install_key,
      installId: row.install_id,
      versionGeneration: row.version_generation,
      eventId: row.event_id,
      receivedAtMs: row.received_at_ms,
      rowBytes: row.row_bytes,
    };
  });
  const selected: SearchLatestPointer[] = [];
  let selectedBytes = 2;
  for (const pointer of pointers) {
    if (
      selectedBytes + pointer.rowBytes + 1 >
      MAX_SOURCE_PROJECTION_EVENT_BYTES
    ) {
      break;
    }
    selected.push(pointer);
    selectedBytes += pointer.rowBytes + 1;
  }
  if (pointers.length > 0 && selected.length === 0) return invalidResult();
  const hydrated = await readD1InsightsPointerEvents(executor, selected, limit);
  const savedLatest = hydrated.map(({ pointer, event }) => {
    const selectedPointer = pointer as SearchLatestPointer;
    if (event.install_id !== selectedPointer.installId) return invalidResult();
    return latest(event, selectedPointer.installKey, -1);
  });
  const exhausted = rows.length < limit && selected.length === pointers.length;
  const checkpoint: JobCheckpoint = exhausted
    ? { phase: "complete" }
    : {
        phase: "searchLatest",
        afterInstallKey: selected.at(-1)?.installKey ?? invalidResult(),
      };
  const writes =
    savedLatest.length === 0 ? [] : [latestStatement(job.id, savedLatest)];
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { selected, hydrated, savedLatest, checkpoint },
  );
  return {
    processed: selected.length,
    leaseLost: committed === "lease-lost",
  };
};

type SourcePointer = D1InsightsEventPointer & { readonly generation: number };

const sourcePage = async (
  executor: D1Executor,
  job: StoredJob,
  limit: number,
): Promise<readonly { generation: number; event: BundleEventRow }[]> => {
  if (job.checkpoint.phase !== "source") return invalidResult();
  const afterGeneration = job.checkpoint.afterGeneration;
  const rows = await executor.query(
    `SELECT generation, event_id, received_at_ms, row_bytes
    FROM ${SOURCE_EVENTS}
    WHERE generation > json_extract(?, '$')
      AND generation <= json_extract(?, '$')
    ORDER BY generation ASC LIMIT json_extract(?, '$')`,
    encodeD1Values([afterGeneration, job.sourceGeneration, limit]),
  );
  if (rows.length > limit) return invalidResult();
  let previous = afterGeneration;
  const pointers = rows.map((value): SourcePointer => {
    if (!record(value) || value.generation !== previous + 1) {
      return invalidResult();
    }
    previous = value.generation;
    if (
      !isCanonicalInsightsEventId(value.event_id) ||
      !safeInteger(value.received_at_ms) ||
      !safeInteger(value.row_bytes) ||
      value.row_bytes < 1 ||
      value.row_bytes > INSIGHTS_EVENT_MAX_BYTES
    ) {
      return invalidResult();
    }
    return {
      generation: value.generation,
      eventId: value.event_id,
      receivedAtMs: value.received_at_ms,
      rowBytes: value.row_bytes,
    };
  });
  if (rows.length < limit && previous !== job.sourceGeneration) {
    return invalidResult();
  }
  const bounded: SourcePointer[] = [];
  let bytes = 2;
  for (const pointer of pointers) {
    const next = bytes + pointer.rowBytes + (bounded.length === 0 ? 0 : 1);
    if (next > MAX_SOURCE_PROJECTION_EVENT_BYTES) break;
    bounded.push(pointer);
    bytes = next;
  }
  if (pointers.length > 0 && bounded.length === 0) return invalidResult();
  return (await readD1InsightsPointerEvents(executor, bounded, limit)).map(
    ({ pointer, event }) => ({
      generation: pointer.generation,
      event,
    }),
  );
};

type MaintenanceInput = {
  readonly maxItems: number;
  readonly maxRequests: number;
};

class D1InsightsStepBudgetExhaustedError extends Error {
  readonly name = "D1InsightsStepBudgetExhaustedError";
}

class BudgetedD1Executor implements D1Executor {
  requests = 0;
  private reservedRequests = 0;

  constructor(
    private readonly executor: D1Executor,
    private readonly maxRequests: number,
  ) {}

  reserve(requests: number): void {
    if (
      !Number.isSafeInteger(requests) ||
      requests < 0 ||
      this.requests + requests > this.maxRequests
    ) {
      throw new D1InsightsStepBudgetExhaustedError();
    }
    this.reservedRequests = requests;
  }

  releaseReserve(): void {
    this.reservedRequests = 0;
  }

  private addRequests(count: number): void {
    if (this.requests + count + this.reservedRequests > this.maxRequests) {
      throw new D1InsightsStepBudgetExhaustedError();
    }
    this.requests += count;
  }

  query(sql: string, params: readonly string[]): Promise<readonly unknown[]> {
    this.addRequests(1);
    return this.executor.query(sql, params);
  }

  batch(
    statements: readonly D1Statement[],
  ): Promise<readonly (readonly unknown[])[]> {
    if (statements.length < 1 || statements.length > MAX_D1_REQUESTS) {
      return invalidResult();
    }
    this.addRequests(statements.length);
    return this.executor.batch(statements);
  }
}

const assertStepPayload = (input: MaintenanceInput, payload: unknown): void => {
  try {
    if (
      getCanonicalInsightsJsonByteLength({ ...input, payload }) >
      INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
    ) {
      invalidResult();
    }
  } catch {
    invalidResult();
  }
};

const nextCheckpoint = (
  current: JobCheckpoint,
  tasks: number,
  task: number,
  create: (next: number) => JobCheckpoint,
  done: JobCheckpoint,
): JobCheckpoint => {
  if (task >= tasks || current.phase === "complete") return invalidResult();
  return task + 1 < tasks ? create(task + 1) : done;
};

const progressJob = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
  checkpoint: JobCheckpoint,
  writes: readonly D1Statement[],
  payload: unknown,
): Promise<"committed" | "lease-lost"> => {
  assertStepPayload(input, payload);
  return commitLeased(executor, job, [
    leaseGuard(job),
    ...writes,
    checkpointStatement(job, checkpoint),
  ]);
};

const stepSource = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (job.checkpoint.phase !== "source" || job.kind !== "report") {
    return invalidResult();
  }
  const limit = Math.min(
    MAX_STEP_EVENTS,
    Math.max(1, Math.floor((input.maxItems - 16) / 6)),
  );
  const page = await sourcePage(executor, job, limit);
  const savedLatest: Latest[] = [];
  const memberships: Membership[] = [];
  const projection =
    job.kind === "report"
      ? createInsightsReportProjection(
          job.query as InsightsReportQuery,
          job.asOfMs,
        )
      : null;
  for (const { event } of page) {
    assertInsightsEventContract(event);
    const installKey = await d1InsightsInstallKey(event.install_id);
    const projected = projection!.project(event);
    if (projected === null) continue;
    if (projected.kind === "movement") {
      memberships.push(
        membership(
          installKey,
          projected.installId,
          "summary",
          projected.metric,
          projected.bundleId,
          -1,
        ),
      );
      if (job.query.kind === "bundleDetail") {
        memberships.push(
          membership(
            installKey,
            projected.installId,
            "movementSeries",
            projected.metric,
            "",
            projected.bucketStartMs,
          ),
          membership(
            installKey,
            projected.installId,
            "movementCohorts",
            projected.metric,
            projected.cohort,
            -1,
          ),
        );
      }
      continue;
    }
    savedLatest.push(latest(projected.event, installKey, -1));
    if (projected.bucketStartMs !== null) {
      const bucketIndex =
        (projected.bucketStartMs - projection!.firstBucketMs!) /
        projection!.bucketSizeMs;
      if (!safeInteger(bucketIndex) || bucketIndex >= MAX_BUCKETS) {
        return invalidResult();
      }
      savedLatest.push(latest(projected.event, installKey, bucketIndex));
    }
  }
  const lastGeneration =
    page.at(-1)?.generation ?? job.checkpoint.afterGeneration;
  const checkpoint =
    lastGeneration === job.sourceGeneration
      ? firstAfterSource(job.query)
      : ({ phase: "source", afterGeneration: lastGeneration } as const);
  const writes: D1Statement[] = [];
  if (savedLatest.length > 0) writes.push(latestStatement(job.id, savedLatest));
  if (memberships.length > 0) {
    writes.push(membershipStatement(job.id, memberships));
  }
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { page, savedLatest, memberships, checkpoint },
  );
  return { processed: page.length, leaseLost: committed === "lease-lost" };
};

type StoredLatest = {
  readonly installKey: string;
  readonly bucketIndex: number;
  readonly installId: string;
  readonly event: BundleEventRow;
};

type StoredLatestPointer = Omit<StoredLatest, "event"> & {
  readonly eventId: string;
  readonly receivedAtMs: number;
  readonly rowBytes: number;
};

const parseStoredLatestPointer = (value: unknown): StoredLatestPointer => {
  if (
    !record(value) ||
    typeof value.install_key !== "string" ||
    !INSTALL_KEY.test(value.install_key) ||
    !Number.isSafeInteger(value.bucket_index) ||
    (value.bucket_index as number) < -1 ||
    (value.bucket_index as number) >= MAX_BUCKETS ||
    typeof value.install_id !== "string" ||
    !isCanonicalInsightsEventId(value.event_id) ||
    !safeInteger(value.received_at_ms) ||
    !safeInteger(value.row_bytes) ||
    value.row_bytes < 1 ||
    value.row_bytes > INSIGHTS_EVENT_MAX_BYTES
  ) {
    return invalidResult();
  }
  return {
    installKey: value.install_key,
    bucketIndex: value.bucket_index as number,
    installId: value.install_id,
    eventId: value.event_id,
    receivedAtMs: value.received_at_ms,
    rowBytes: value.row_bytes,
  };
};

const parseStoredLatest = async (value: unknown): Promise<StoredLatest> => {
  if (
    !record(value) ||
    typeof value.install_key !== "string" ||
    !INSTALL_KEY.test(value.install_key) ||
    !Number.isSafeInteger(value.bucket_index) ||
    (value.bucket_index as number) < -1 ||
    typeof value.install_id !== "string" ||
    !isCanonicalInsightsEventId(value.event_id) ||
    !safeInteger(value.received_at_ms) ||
    !safeInteger(value.row_bytes) ||
    typeof value.event_json !== "string"
  ) {
    return invalidResult();
  }
  const event = parseJson(value.event_json);
  try {
    assertInsightsEventContract(event);
  } catch {
    return invalidResult();
  }
  if (
    event.install_id !== value.install_id ||
    event.id !== value.event_id ||
    event.received_at_ms !== value.received_at_ms ||
    canonicalInsightsJson(event) !== value.event_json ||
    getCanonicalInsightsJsonByteLength(event) !== value.row_bytes ||
    (await d1InsightsInstallKey(event.install_id)) !== value.install_key
  ) {
    return invalidResult();
  }
  return {
    installKey: value.install_key,
    bucketIndex: value.bucket_index as number,
    installId: value.install_id,
    event,
  };
};

const latestSelect = `install_key, bucket_index, install_id, event_id,
  received_at_ms, row_bytes, event_json`;
const latestPointerSelect = `install_key, bucket_index, install_id, event_id,
  received_at_ms, row_bytes`;

const stepInstallations = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (
    job.checkpoint.phase !== "installations" ||
    (job.query.kind !== "installationOverview" &&
      job.query.kind !== "activeOverview")
  ) {
    return invalidResult();
  }
  const limit = Math.min(100, Math.max(1, Math.floor(input.maxItems / 123)));
  const rows = await executor.query(
    `SELECT ${latestPointerSelect} FROM ${LATEST}
    INDEXED BY private_hot_updater_insights_job_latest_scan_idx
    WHERE job_id = json_extract(?, '$') COLLATE BINARY AND bucket_index = -1
      ${
        job.checkpoint.afterInstallKey === null
          ? ""
          : "AND install_key > json_extract(?, '$') COLLATE BINARY"
      }
    ORDER BY install_key COLLATE BINARY ASC LIMIT json_extract(?, '$')`,
    encodeD1Values([
      job.id,
      ...(job.checkpoint.afterInstallKey === null
        ? []
        : [job.checkpoint.afterInstallKey]),
      limit,
    ]),
  );
  if (rows.length > limit) return invalidResult();
  const latestPointers = rows.map(parseStoredLatestPointer);
  let previous = job.checkpoint.afterInstallKey;
  for (const row of latestPointers) {
    if (
      row.bucketIndex !== -1 ||
      (previous !== null && row.installKey <= previous)
    ) {
      return invalidResult();
    }
    previous = row.installKey;
  }
  let bucketPointers: readonly StoredLatestPointer[] = [];
  if (job.query.kind === "activeOverview" && latestPointers.length > 0) {
    const selected = await executor.query(
      `SELECT ${latestPointerSelect} FROM ${LATEST}
      WHERE job_id = json_extract(?, '$') COLLATE BINARY
        AND install_key IN (SELECT value FROM json_each(?))
        AND bucket_index >= 0
      ORDER BY install_key COLLATE BINARY ASC, bucket_index ASC
      LIMIT json_extract(?, '$')`,
      [
        ...encodeD1Values([job.id]),
        JSON.stringify(latestPointers.map((row) => row.installKey)),
        ...encodeD1Values([latestPointers.length * MAX_BUCKETS + 1]),
      ],
    );
    if (selected.length > latestPointers.length * MAX_BUCKETS)
      return invalidResult();
    bucketPointers = selected.map(parseStoredLatestPointer);
  }
  const pointerBuckets = new Map<string, StoredLatestPointer[]>();
  for (const row of bucketPointers) {
    if (
      row.bucketIndex < 0 ||
      !latestPointers.some((item) => item.installKey === row.installKey)
    ) {
      return invalidResult();
    }
    const bucket = pointerBuckets.get(row.installKey) ?? [];
    if (bucket.length > 0 && bucket.at(-1)!.bucketIndex >= row.bucketIndex) {
      return invalidResult();
    }
    bucket.push(row);
    pointerBuckets.set(row.installKey, bucket);
  }
  const selectedInstallKeys: string[] = [];
  const selectedPointers: StoredLatestPointer[] = [];
  let selectedBytes = 2;
  for (const latest of latestPointers) {
    const group = [latest, ...(pointerBuckets.get(latest.installKey) ?? [])];
    const groupBytes = group.reduce((sum, row) => sum + row.rowBytes + 1, 0);
    if (selectedBytes + groupBytes > INSIGHTS_PAGE_MAX_BYTES) break;
    selectedInstallKeys.push(latest.installKey);
    selectedPointers.push(...group);
    selectedBytes += groupBytes;
  }
  if (latestPointers.length > 0 && selectedInstallKeys.length === 0) {
    return invalidResult();
  }
  const hydrated =
    selectedPointers.length === 0
      ? []
      : await executor.query(
          `SELECT ${latestSelect} FROM ${LATEST}
          WHERE job_id = json_extract(?, '$') COLLATE BINARY
            AND install_key IN (SELECT value FROM json_each(?))
          ORDER BY install_key COLLATE BINARY ASC, bucket_index ASC
          LIMIT json_extract(?, '$')`,
          [
            ...encodeD1Values([job.id]),
            JSON.stringify(selectedInstallKeys),
            ...encodeD1Values([selectedPointers.length + 1]),
          ],
        );
  if (hydrated.length !== selectedPointers.length) return invalidResult();
  const hydratedRows = await Promise.all(hydrated.map(parseStoredLatest));
  for (const [index, row] of hydratedRows.entries()) {
    const pointer = selectedPointers[index];
    if (
      pointer === undefined ||
      row.installKey !== pointer.installKey ||
      row.bucketIndex !== pointer.bucketIndex ||
      row.installId !== pointer.installId ||
      row.event.id !== pointer.eventId ||
      row.event.received_at_ms !== pointer.receivedAtMs ||
      getCanonicalInsightsJsonByteLength(row.event) !== pointer.rowBytes
    ) {
      return invalidResult();
    }
  }
  const selectedKeySet = new Set(selectedInstallKeys);
  const latestRows = hydratedRows.filter(
    ({ bucketIndex }) => bucketIndex === -1,
  );
  const bucketRows = hydratedRows.filter(({ bucketIndex }) => bucketIndex >= 0);
  if (latestRows.length !== selectedInstallKeys.length) return invalidResult();
  const byInstall = new Map<string, StoredLatest[]>();
  for (const row of bucketRows) {
    if (!selectedKeySet.has(row.installKey)) return invalidResult();
    const bucket = byInstall.get(row.installKey) ?? [];
    bucket.push(row);
    byInstall.set(row.installKey, bucket);
  }
  const counts: Membership[] = [];
  const projection = createInsightsReportProjection(job.query, job.asOfMs);
  for (const row of latestRows) {
    if (
      job.query.kind === "activeOverview" &&
      job.query.userId !== undefined &&
      row.event.user_id !== job.query.userId
    ) {
      continue;
    }
    counts.push(
      membership(row.installKey, row.installId, "installations", "", "", -1),
      membership(
        row.installKey,
        row.installId,
        "bundleDistribution",
        "",
        row.event.to_bundle_id,
        -1,
      ),
    );
    if (job.query.kind !== "activeOverview") continue;
    for (const bucket of byInstall.get(row.installKey) ?? []) {
      const projected = projection.project(bucket.event);
      const bucketStartMs =
        projection.firstBucketMs! +
        bucket.bucketIndex * projection.bucketSizeMs;
      if (
        bucket.installId !== row.installId ||
        projected?.kind !== "installation" ||
        projected.bucketStartMs !== bucketStartMs
      ) {
        return invalidResult();
      }
      counts.push(
        membership(
          row.installKey,
          row.installId,
          "activeSeries",
          "",
          "",
          bucketStartMs,
        ),
        membership(
          row.installKey,
          row.installId,
          "activeBundleSeries",
          "",
          bucket.event.to_bundle_id,
          bucketStartMs,
        ),
        membership(
          await digestHex(
            canonicalInsightsJson([
              "active-bundle-total",
              row.installKey,
              bucketStartMs,
            ]),
          ),
          row.installId,
          "activeBundleTotals",
          "",
          bucket.event.to_bundle_id,
          -1,
        ),
      );
    }
  }
  const exhausted =
    rows.length < limit && selectedInstallKeys.length === latestPointers.length;
  const checkpoint = exhausted
    ? afterInstallations(job.query)
    : ({
        phase: "installations",
        afterInstallKey: selectedInstallKeys.at(-1)!,
      } as const);
  const writes = counts.length > 0 ? [membershipStatement(job.id, counts)] : [];
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { latestRows, bucketRows, counts, checkpoint },
  );
  return {
    processed: latestRows.length,
    leaseLost: committed === "lease-lost",
  };
};

const orderStatement = (
  jobId: string,
  key: string,
  rows: readonly {
    orderKey: string;
    countKey: string;
    label: string;
    value: number;
  }[],
): D1Statement => ({
  sql: `INSERT INTO ${ORDER} (
      job_id, section_key, order_key, count_key, label, value
    ) SELECT json_extract(?, '$'), json_extract(?, '$'),
      json_extract(value, '$.orderKey'), json_extract(value, '$.countKey'),
      json_extract(value, '$.label'), json_extract(value, '$.value')
    FROM json_each(?)`,
  params: [JSON.stringify(jobId), JSON.stringify(key), JSON.stringify(rows)],
});

const stepOrder = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (job.checkpoint.phase !== "order") return invalidResult();
  const tasks = orderTasks(job.query);
  const task = tasks[job.checkpoint.task];
  if (task === undefined) return invalidResult();
  const limit = Math.min(100, input.maxItems);
  const rows = await executor.query(
    `SELECT count_key, label, bucket_start_ms, value FROM ${COUNTS}
    INDEXED BY private_hot_updater_insights_job_count_order_idx
    WHERE job_id = json_extract(?, '$') COLLATE BINARY
      AND section = json_extract(?, '$') AND metric = json_extract(?, '$')
      ${
        job.checkpoint.afterCountKey === null
          ? ""
          : "AND count_key > json_extract(?, '$') COLLATE BINARY"
      }
    ORDER BY count_key COLLATE BINARY ASC LIMIT json_extract(?, '$')`,
    encodeD1Values([
      job.id,
      task.section,
      task.metric,
      ...(job.checkpoint.afterCountKey === null
        ? []
        : [job.checkpoint.afterCountKey]),
      limit,
    ]),
  );
  if (rows.length > limit) return invalidResult();
  let previous = job.checkpoint.afterCountKey;
  const ordered = rows.map((row) => {
    if (
      !record(row) ||
      typeof row.count_key !== "string" ||
      typeof row.label !== "string" ||
      row.bucket_start_ms !== -1 ||
      !safeInteger(row.value) ||
      row.value < 1 ||
      (previous !== null && row.count_key <= previous) ||
      row.count_key !== countIdentity(task.section, task.metric, row.label, -1)
    ) {
      return invalidResult();
    }
    previous = row.count_key;
    const labelKey = jsStringOrderKey(row.label);
    return {
      orderKey:
        task.section === "movementCohorts"
          ? `${labelKey}:${row.count_key}`
          : `${String(MAX_SAFE_COUNT - row.value).padStart(16, "0")}:${labelKey}:${row.count_key}`,
      countKey: row.count_key,
      label: row.label,
      value: row.value,
    };
  });
  const exhausted = rows.length < limit;
  const checkpoint = exhausted
    ? nextCheckpoint(
        job.checkpoint,
        tasks.length,
        job.checkpoint.task,
        (next) => ({ phase: "order", task: next, afterCountKey: null }),
        afterOrdering(job.query),
      )
    : ({
        phase: "order",
        task: job.checkpoint.task,
        afterCountKey: previous,
      } as const);
  const writes =
    ordered.length > 0
      ? [orderStatement(job.id, sectionKey(task.section, task.metric), ordered)]
      : [];
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { ordered, checkpoint },
  );
  return { processed: rows.length, leaseLost: committed === "lease-lost" };
};

type PageRow = {
  readonly ordinal: number;
  readonly filterLabel: string;
  readonly filterOrdinal: number;
  readonly rowBytes: number;
  readonly rowJson: string;
};

const pageRowsStatement = (
  jobId: string,
  key: string,
  rows: readonly PageRow[],
): D1Statement => ({
  sql: `INSERT INTO ${PAGE_ROWS} (
      job_id, section_key, ordinal, filter_label, filter_ordinal,
      row_bytes, row_json
    ) SELECT json_extract(?, '$'), json_extract(?, '$'),
      json_extract(value, '$.ordinal'), json_extract(value, '$.filterLabel'),
      json_extract(value, '$.filterOrdinal'), json_extract(value, '$.rowBytes'),
      json_extract(value, '$.rowJson') FROM json_each(?)`,
  params: [JSON.stringify(jobId), JSON.stringify(key), JSON.stringify(rows)],
});

const sectionStatement = (
  jobId: string,
  key: string,
  totalRows: number,
): D1Statement => ({
  sql: `INSERT INTO ${SECTIONS} (job_id, section_key, total_rows)
    VALUES (json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'))`,
  params: encodeD1Values([jobId, key, totalRows]),
});

const pageRow = (
  ordinal: number,
  filterLabel: string,
  filterOrdinal: number,
  value: unknown,
): PageRow => {
  const rowJson = canonicalInsightsJson(value);
  const rowBytes = getCanonicalInsightsJsonByteLength(value);
  if (rowBytes < 1 || rowBytes > INSIGHTS_PAGE_MAX_BYTES)
    return invalidResult();
  return { ordinal, filterLabel, filterOrdinal, rowBytes, rowJson };
};

const stepRows = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (job.checkpoint.phase !== "rows") return invalidResult();
  const tasks = orderTasks(job.query);
  const task = tasks[job.checkpoint.task];
  if (task === undefined) return invalidResult();
  const projection =
    job.query.kind === "activeOverview"
      ? createInsightsReportProjection(job.query, job.asOfMs)
      : null;
  const active = task.section === "activeBundleTotals";
  const bucketCount = active
    ? Math.floor(
        (projection!.lastBucketMs - projection!.firstBucketMs!) /
          projection!.bucketSizeMs,
      ) + 1
    : 1;
  if (bucketCount < 1 || bucketCount > MAX_BUCKETS) return invalidResult();
  const limit = Math.min(
    100,
    Math.max(1, Math.floor(INSIGHTS_PAGE_MAX_ROWS / bucketCount)),
    Math.max(1, Math.floor(input.maxItems / bucketCount)),
  );
  const key = sectionKey(task.section, task.metric);
  const ordered = await executor.query(
    `SELECT order_key, count_key, label, value FROM ${ORDER}
    WHERE job_id = json_extract(?, '$') COLLATE BINARY
      AND section_key = json_extract(?, '$')
      ${
        job.checkpoint.afterOrderKey === null
          ? ""
          : "AND order_key > json_extract(?, '$') COLLATE BINARY"
      }
    ORDER BY order_key COLLATE BINARY ASC LIMIT json_extract(?, '$')`,
    encodeD1Values([
      job.id,
      key,
      ...(job.checkpoint.afterOrderKey === null
        ? []
        : [job.checkpoint.afterOrderKey]),
      limit,
    ]),
  );
  if (ordered.length > limit) return invalidResult();
  let previous = job.checkpoint.afterOrderKey;
  const saved = ordered.map((row) => {
    if (
      !record(row) ||
      typeof row.order_key !== "string" ||
      typeof row.count_key !== "string" ||
      typeof row.label !== "string" ||
      !safeInteger(row.value) ||
      row.value < 1 ||
      (previous !== null && row.order_key <= previous)
    ) {
      return invalidResult();
    }
    previous = row.order_key;
    return {
      orderKey: row.order_key,
      countKey: row.count_key,
      label: row.label,
      value: row.value,
    };
  });
  const values = new Map<string, number>();
  if (active && saved.length > 0) {
    const counts = await executor.query(
      `SELECT count_key, label, bucket_start_ms, value FROM ${COUNTS}
      INDEXED BY private_hot_updater_insights_job_count_series_idx
      WHERE job_id = json_extract(?, '$') COLLATE BINARY
        AND section = 'activeBundleSeries' AND metric = ''
        AND label IN (SELECT value FROM json_each(?))
        AND bucket_start_ms >= json_extract(?, '$')
        AND bucket_start_ms <= json_extract(?, '$')
      LIMIT json_extract(?, '$')`,
      [
        ...encodeD1Values([job.id]),
        JSON.stringify(saved.map((row) => row.label)),
        ...encodeD1Values([
          projection!.firstBucketMs,
          projection!.lastBucketMs,
          saved.length * bucketCount,
        ]),
      ],
    );
    for (const row of counts) {
      if (
        !record(row) ||
        typeof row.count_key !== "string" ||
        typeof row.label !== "string" ||
        !safeInteger(row.bucket_start_ms) ||
        !safeInteger(row.value) ||
        row.value < 1 ||
        row.count_key !==
          countIdentity(
            "activeBundleSeries",
            "",
            row.label,
            row.bucket_start_ms,
          )
      ) {
        return invalidResult();
      }
      if (values.has(row.count_key)) return invalidResult();
      values.set(row.count_key, row.value);
    }
  }
  const rows: PageRow[] = [];
  let ordinal = job.checkpoint.nextOrdinal;
  for (const row of saved) {
    if (active) {
      for (let index = 0; index < bucketCount; index += 1) {
        const bucketStartMs =
          projection!.firstBucketMs! + index * projection!.bucketSizeMs;
        rows.push(
          pageRow(ordinal, row.label, index, {
            bundleId: row.label,
            bucketStartMs,
            value:
              values.get(
                countIdentity(
                  "activeBundleSeries",
                  "",
                  row.label,
                  bucketStartMs,
                ),
              ) ?? 0,
          }),
        );
        ordinal += 1;
      }
    } else {
      rows.push(
        pageRow(
          ordinal,
          "",
          ordinal,
          task.section === "movementCohorts"
            ? { cohort: row.label, value: row.value }
            : { bundleId: row.label, installations: row.value },
        ),
      );
      ordinal += 1;
    }
  }
  const exhausted = ordered.length < limit;
  const publicKey = sectionKey(
    active ? "activeBundleSeries" : task.section,
    task.metric,
  );
  const checkpoint = exhausted
    ? nextCheckpoint(
        job.checkpoint,
        tasks.length,
        job.checkpoint.task,
        (next) => ({
          phase: "rows",
          task: next,
          afterOrderKey: null,
          nextOrdinal: 0,
        }),
        afterRows(job.query),
      )
    : ({
        phase: "rows",
        task: job.checkpoint.task,
        afterOrderKey: previous,
        nextOrdinal: ordinal,
      } as const);
  const writes: D1Statement[] = [];
  if (rows.length > 0) writes.push(pageRowsStatement(job.id, publicKey, rows));
  if (exhausted) writes.push(sectionStatement(job.id, publicKey, ordinal));
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { ordered: saved, rows, checkpoint },
  );
  return { processed: rows.length, leaseLost: committed === "lease-lost" };
};

const stepSeries = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<{ readonly processed: number; readonly leaseLost: boolean }> => {
  if (job.checkpoint.phase !== "series") return invalidResult();
  const current = job.checkpoint;
  const tasks = seriesTasks(job.query);
  const task = tasks[job.checkpoint.task];
  if (task === undefined || job.kind !== "report") return invalidResult();
  const projection = createInsightsReportProjection(
    job.query as InsightsReportQuery,
    job.asOfMs,
  );
  let nextBucketMs = current.nextBucketMs;
  if (nextBucketMs === null) {
    if (projection.firstBucketMs !== null) {
      nextBucketMs = projection.firstBucketMs;
    } else {
      const first = await executor.query(
        `SELECT MIN(bucket_start_ms) AS first_bucket_ms FROM ${COUNTS}
        INDEXED BY private_hot_updater_insights_job_count_series_idx
        WHERE job_id = json_extract(?, '$') COLLATE BINARY
          AND section = json_extract(?, '$') AND metric = json_extract(?, '$')`,
        encodeD1Values([job.id, task.section, task.metric]),
      );
      if (first.length !== 1 || !record(first[0])) return invalidResult();
      nextBucketMs =
        first[0].first_bucket_ms === null
          ? projection.lastBucketMs
          : safeInteger(first[0].first_bucket_ms)
            ? first[0].first_bucket_ms
            : invalidResult();
    }
  }
  if (
    !safeInteger(nextBucketMs) ||
    nextBucketMs > projection.lastBucketMs ||
    (projection.lastBucketMs - nextBucketMs) % projection.bucketSizeMs !== 0
  ) {
    return invalidResult();
  }
  const remaining =
    Math.floor(
      (projection.lastBucketMs - nextBucketMs) / projection.bucketSizeMs,
    ) + 1;
  const size = Math.min(INSIGHTS_PAGE_MAX_ROWS, input.maxItems, remaining);
  const last = nextBucketMs + (size - 1) * projection.bucketSizeMs;
  const saved = await executor.query(
    `SELECT count_key, bucket_start_ms, value FROM ${COUNTS}
    INDEXED BY private_hot_updater_insights_job_count_series_idx
    WHERE job_id = json_extract(?, '$') COLLATE BINARY
      AND section = json_extract(?, '$') AND metric = json_extract(?, '$')
      AND label = '' AND bucket_start_ms >= json_extract(?, '$')
      AND bucket_start_ms <= json_extract(?, '$')
    ORDER BY bucket_start_ms ASC LIMIT json_extract(?, '$')`,
    encodeD1Values([
      job.id,
      task.section,
      task.metric,
      nextBucketMs,
      last,
      size,
    ]),
  );
  const values = new Map<number, number>();
  for (const row of saved) {
    if (
      !record(row) ||
      typeof row.count_key !== "string" ||
      !safeInteger(row.bucket_start_ms) ||
      !safeInteger(row.value) ||
      row.value < 1 ||
      row.count_key !==
        countIdentity(task.section, task.metric, "", row.bucket_start_ms) ||
      values.has(row.bucket_start_ms)
    ) {
      return invalidResult();
    }
    values.set(row.bucket_start_ms, row.value);
  }
  const rows = Array.from({ length: size }, (_, index) => {
    const bucketStartMs = nextBucketMs! + index * projection.bucketSizeMs;
    return pageRow(
      current.nextOrdinal + index,
      "",
      current.nextOrdinal + index,
      {
        bucketStartMs,
        value: values.get(bucketStartMs) ?? 0,
      },
    );
  });
  const ordinal = current.nextOrdinal + rows.length;
  const exhausted = last === projection.lastBucketMs;
  const publicKey = sectionKey(task.section, task.metric);
  const checkpoint = exhausted
    ? nextCheckpoint(
        job.checkpoint,
        tasks.length,
        job.checkpoint.task,
        (next) => ({
          phase: "series",
          task: next,
          nextBucketMs: null,
          nextOrdinal: 0,
        }),
        { phase: "complete" },
      )
    : ({
        phase: "series",
        task: job.checkpoint.task,
        nextBucketMs: last + projection.bucketSizeMs,
        nextOrdinal: ordinal,
      } as const);
  const writes: D1Statement[] = [pageRowsStatement(job.id, publicKey, rows)];
  if (exhausted) writes.push(sectionStatement(job.id, publicKey, ordinal));
  const committed = await progressJob(
    executor,
    input,
    job,
    checkpoint,
    writes,
    { rows, checkpoint },
  );
  return { processed: rows.length, leaseLost: committed === "lease-lost" };
};

const requestedSummaryCounts = (query: PrivateQuery): readonly string[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return query.bundleIds.flatMap((bundleId) => [
        countIdentity("summary", "installed", bundleId, -1),
        countIdentity("summary", "recovered", bundleId, -1),
      ]);
    case "bundleDetail":
      return [
        countIdentity("summary", "installed", query.bundleId, -1),
        countIdentity("summary", "recovered", query.bundleId, -1),
      ];
    case "installationOverview":
    case "activeOverview":
      return [countIdentity("installations", "", "", -1)];
    case "installationContains":
    case "installationUserId":
      return [countIdentity("search", "", "", -1)];
  }
};

const requiredSections = (query: PrivateQuery): readonly string[] => {
  switch (query.kind) {
    case "bundleDetail":
      return [
        sectionKey("movementCohorts", "installed"),
        sectionKey("movementCohorts", "recovered"),
        sectionKey("movementSeries", "installed"),
        sectionKey("movementSeries", "recovered"),
      ];
    case "installationOverview":
      return [sectionKey("bundleDistribution")];
    case "activeOverview":
      return [
        sectionKey("bundleDistribution"),
        sectionKey("activeBundleSeries"),
        sectionKey("activeSeries"),
      ];
    default:
      return [];
  }
};

const publishJob = async (
  executor: D1Executor,
  input: MaintenanceInput,
  job: StoredJob,
): Promise<"committed" | "lease-lost"> => {
  if (job.checkpoint.phase !== "complete") return invalidResult();
  const requested = requestedSummaryCounts(job.query);
  const rows = await executor.query(
    `SELECT count_key, section, metric, label, bucket_start_ms, value
    FROM ${COUNTS} WHERE job_id = json_extract(?, '$') COLLATE BINARY
      AND count_key IN (SELECT value FROM json_each(?))
    LIMIT json_extract(?, '$')`,
    [
      ...encodeD1Values([job.id]),
      JSON.stringify(requested),
      ...encodeD1Values([requested.length]),
    ],
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (
      !record(row) ||
      typeof row.count_key !== "string" ||
      typeof row.section !== "string" ||
      typeof row.metric !== "string" ||
      typeof row.label !== "string" ||
      !Number.isSafeInteger(row.bucket_start_ms) ||
      !safeInteger(row.value) ||
      row.value < 1 ||
      row.count_key !==
        countIdentity(
          row.section,
          row.metric,
          row.label,
          row.bucket_start_ms as number,
        ) ||
      !requested.includes(row.count_key) ||
      counts.has(row.count_key)
    ) {
      return invalidResult();
    }
    counts.set(row.count_key, row.value);
  }
  const sections = requiredSections(job.query);
  if (sections.length > 0) {
    const ready = await executor.query(
      `SELECT section_key FROM ${SECTIONS}
      WHERE job_id = json_extract(?, '$') COLLATE BINARY
        AND section_key IN (SELECT value FROM json_each(?))
      LIMIT json_extract(?, '$')`,
      [
        ...encodeD1Values([job.id]),
        JSON.stringify(sections),
        ...encodeD1Values([sections.length]),
      ],
    );
    if (
      ready.length !== sections.length ||
      new Set(
        ready.map((row) =>
          record(row) && typeof row.section_key === "string"
            ? row.section_key
            : invalidResult(),
        ),
      ).size !== sections.length
    ) {
      return invalidResult();
    }
  }
  const value = (key: string) => counts.get(key) ?? 0;
  const completedAtMs = await currentD1Time(executor);
  const base = {
    id: job.id,
    asOfMs: job.asOfMs,
    completedAtMs,
    sourceGeneration: sourceGeneration(job),
    accuracy: "exact" as const,
  };
  let publication: D1InsightsPrivatePublication | InsightsReportPublication;
  let resultTotal: number | null = null;
  switch (job.query.kind) {
    case "installationContains":
    case "installationUserId":
      resultTotal = value(countIdentity("search", "", "", -1));
      publication = { ...base, total: resultTotal };
      break;
    case "bundleSummaries":
      publication = {
        ...base,
        kind: job.query.kind,
        summary: job.query.bundleIds.map((bundleId) => ({
          bundleId,
          installed: value(countIdentity("summary", "installed", bundleId, -1)),
          recovered: value(countIdentity("summary", "recovered", bundleId, -1)),
        })),
      };
      break;
    case "bundleDetail":
      publication = {
        ...base,
        kind: job.query.kind,
        summary: {
          installed: value(
            countIdentity("summary", "installed", job.query.bundleId, -1),
          ),
          recovered: value(
            countIdentity("summary", "recovered", job.query.bundleId, -1),
          ),
        },
      };
      break;
    case "installationOverview":
      publication = {
        ...base,
        kind: job.query.kind,
        summary: {
          trackedInstallations: value(
            countIdentity("installations", "", "", -1),
          ),
        },
      };
      break;
    case "activeOverview":
      publication = {
        ...base,
        kind: job.query.kind,
        summary: {
          activeInstallations: value(
            countIdentity("installations", "", "", -1),
          ),
        },
      };
      break;
  }
  assertStepPayload(input, { publication, rows, sections });
  return commitLeased(executor, job, [
    leaseGuard(job),
    {
      sql: `UPDATE ${JOBS} SET status = 'ready', checkpoint_json = json_extract(?, '$'),
        publication_json = json_extract(?, '$'), result_total = json_extract(?, '$'),
        completed_at_ms = json_extract(?, '$'), lease_until_ms = 0,
        revision = revision + 1
      WHERE id = json_extract(?, '$') COLLATE BINARY AND status = 'preparing'
        AND lease_epoch = json_extract(?, '$') AND revision = json_extract(?, '$')`,
      params: encodeD1Values([
        canonicalInsightsJson({ phase: "complete" }),
        canonicalInsightsJson(publication),
        resultTotal,
        completedAtMs,
        job.id,
        job.leaseEpoch,
        job.revision,
      ]),
    },
    {
      sql: `UPDATE ${HEADS} SET publication_job_id = json_extract(?, '$'),
        active_job_id = NULL
      WHERE query_key = json_extract(?, '$') COLLATE BINARY
        AND active_job_id = json_extract(?, '$')
        AND EXISTS (SELECT 1 FROM ${JOBS} WHERE id = json_extract(?, '$')
          AND status = 'ready')`,
      params: encodeD1Values([job.id, job.queryKey, job.id, job.id]),
    },
    {
      sql: `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM ${JOBS} AS job
          JOIN ${HEADS} AS head ON head.query_key = job.query_key
          WHERE job.id = json_extract(?, '$') COLLATE BINARY
            AND job.status = 'ready' AND job.revision = json_extract(?, '$')
            AND head.publication_job_id = job.id AND head.active_job_id IS NULL
        ) THEN json_extract(?, '$')
        ELSE json_extract('HOT_UPDATER_INSIGHTS_PUBLICATION_NOT_ATOMIC', '$')
        END AS revision`,
      params: encodeD1Values([job.id, job.revision + 1, job.revision + 1]),
    },
  ]);
};

const claimJob = async (executor: D1Executor): Promise<StoredJob | null> => {
  const rows = await executor.query(
    `UPDATE ${JOBS} SET status = 'preparing', lease_epoch = lease_epoch + 1,
      lease_until_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + ${LEASE_MS},
      revision = revision + 1
    WHERE id = COALESCE(
      (
        SELECT job.id FROM ${JOBS} AS job
          INDEXED BY private_hot_updater_insights_job_lease_idx
        JOIN ${HEADS} AS head ON head.active_job_id = job.id
        WHERE job.status = 'preparing' AND job.lease_until_ms <=
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
        ORDER BY job.lease_until_ms ASC, job.id COLLATE BINARY ASC LIMIT 1
      ),
      (
        SELECT job.id FROM ${JOBS} AS job
          INDEXED BY private_hot_updater_insights_job_claim_idx
        JOIN ${HEADS} AS head ON head.active_job_id = job.id
        WHERE job.status = 'queued' AND job.claimable_at_ms <=
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
        ORDER BY job.claimable_at_ms ASC, job.id COLLATE BINARY ASC LIMIT 1
      )
    )
    RETURNING ${jobSelect}`,
    [],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) return invalidResult();
  const job = await parseJob(rows[0]);
  return job.status === "preparing" ? job : invalidResult();
};

const finishFailed = async (
  executor: D1Executor,
  job: StoredJob,
  failureCode: "preparation-failed" | "migration-poison",
): Promise<"failed" | "lease-lost"> => {
  const committed = await commitLeased(executor, job, [
    leaseGuard(job),
    {
      sql: `UPDATE ${JOBS} SET status = 'failed', lease_until_ms = 0,
        failure_code = json_extract(?, '$'), revision = revision + 1
      WHERE id = json_extract(?, '$') COLLATE BINARY AND status = 'preparing'
        AND lease_epoch = json_extract(?, '$') AND revision = json_extract(?, '$')
      RETURNING revision`,
      params: encodeD1Values([
        failureCode,
        job.id,
        job.leaseEpoch,
        job.revision,
      ]),
    },
  ]);
  return committed === "committed" ? "failed" : "lease-lost";
};

const deferJob = async (
  executor: D1Executor,
  job: StoredJob,
): Promise<"not-ready" | "lease-lost"> => {
  const committed = await commitLeased(executor, job, [
    leaseGuard(job),
    {
      sql: `UPDATE ${JOBS} SET status = 'queued', lease_until_ms = 0,
        claimable_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 1000,
        revision = revision + 1
      WHERE id = json_extract(?, '$') COLLATE BINARY AND status = 'preparing'
        AND lease_epoch = json_extract(?, '$') AND revision = json_extract(?, '$')
      RETURNING revision`,
      params: encodeD1Values([job.id, job.leaseEpoch, job.revision]),
    },
  ]);
  return committed === "committed" ? "not-ready" : "lease-lost";
};

export const createD1InsightsMaintenance = (
  executor: D1Executor,
  databaseNamespace: string,
) => {
  assertD1InsightsDatabaseNamespace(databaseNamespace);
  return {
    async runStep(
      input: MaintenanceInput,
    ): Promise<D1InsightsMaintenanceResult> {
      try {
        assertInsightsMaintenanceInputContract(input);
      } catch {
        invalidQuery();
      }
      // Namespace, job/source layout, source state, and the lease claim require
      // five requests.
      // Keep two more available to durably defer any claimed job that cannot
      // complete a bounded step with the caller's remaining budget.
      if (input.maxRequests < 7) {
        return { state: "idle", processed: 0, requests: 0 };
      }
      const budgeted = new BudgetedD1Executor(executor, input.maxRequests);
      try {
        await verifyD1InsightsDatabaseNamespace(budgeted, databaseNamespace);
        await assertD1InsightsJobsLayout(budgeted);
        await assertD1InsightsReady(budgeted);
      } catch (error) {
        if (error instanceof D1InsightsMigrationPoisonError) {
          return {
            state: "failed",
            processed: 0,
            requests: budgeted.requests,
            jobId: error.sourceId,
            error: { code: "migration-poison", jobId: error.sourceId },
          };
        }
        if (error instanceof InsightsQueryNotReadyError) {
          return {
            state: "not-ready",
            processed: 0,
            requests: budgeted.requests,
          };
        }
        throw error;
      }
      const job = await claimJob(budgeted);
      if (job === null) {
        return { state: "idle", processed: 0, requests: budgeted.requests };
      }
      budgeted.reserve(2);
      try {
        if (job.checkpoint.phase === "complete") {
          const state = await publishJob(budgeted, input, job);
          return {
            state: state === "lease-lost" ? "lease-lost" : "published",
            processed: 0,
            requests: budgeted.requests,
            jobId: job.id,
          };
        }
        const result =
          job.checkpoint.phase === "aliases"
            ? await stepAliases(budgeted, input, job)
            : job.checkpoint.phase === "searchLatest"
              ? await stepSearchLatest(budgeted, input, job)
              : job.checkpoint.phase === "source"
                ? await stepSource(budgeted, input, job)
                : job.checkpoint.phase === "installations"
                  ? await stepInstallations(budgeted, input, job)
                  : job.checkpoint.phase === "order"
                    ? await stepOrder(budgeted, input, job)
                    : job.checkpoint.phase === "rows"
                      ? await stepRows(budgeted, input, job)
                      : await stepSeries(budgeted, input, job);
        return {
          state: result.leaseLost ? "lease-lost" : "progress",
          processed: result.leaseLost ? 0 : result.processed,
          requests: budgeted.requests,
          jobId: job.id,
        };
      } catch (error) {
        budgeted.releaseReserve();
        const provenCorruption =
          isProvenJobCorruption(error) ||
          isProvenPublicationInvariantFailure(error, job);
        if (
          error instanceof InsightsQueryNotReadyError ||
          error instanceof D1InsightsStepBudgetExhaustedError ||
          (!provenCorruption && !(error instanceof DatabasePluginInputError))
        ) {
          const state = await deferJob(budgeted, job);
          return {
            state,
            processed: 0,
            requests: budgeted.requests,
            jobId: job.id,
          };
        }
        const state = await finishFailed(
          budgeted,
          job,
          provenCorruption ? "migration-poison" : "preparation-failed",
        );
        return {
          state,
          processed: 0,
          requests: budgeted.requests,
          jobId: job.id,
        };
      }
    },
  };
};
