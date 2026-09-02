import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsInitialPublishedInstallationPage,
  type InsightsInitialPublishedInstallationPageInput,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsModel,
  type InsightsPinnedInstallationPage,
  type InsightsPinnedInstallationPageInput,
  type InsightsPublishedInstallationContinuation,
  type InsightsPublishedInstallationContinuationInput,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageInput,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsEventContract,
  assertInsightsPageContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  assertInsightsMaintenanceInputContract,
  createInsightsReportPageCursor,
  getCanonicalInsightsJsonByteLength,
  getInsightsInstallationOrderKey,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
  readInsightsReportPageInput,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_V1_FUNCTION_NAMES } from "./supabaseInfrastructureNames";
import { throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

const schemaVersion = "1.0.0";
const storageVersion = "supabase-insights-v2";
const installationOrderRevision = "sha256-json-string-v1";
const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonicalEventId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalDatabaseNamespace =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RpcClient = Pick<SupabaseClient<Database>, "rpc">;
type JsonObject = Record<string, unknown>;

export interface SupabaseInsightsMaintenanceInput {
  readonly maxItems: number;
  readonly maxRequests: number;
  readonly maxBytes?: number;
}

export type SupabaseInsightsMaintenanceResult =
  | {
      readonly state: "complete";
      readonly publicationId: string;
      readonly usage: {
        readonly items: number;
        readonly requests: number;
        readonly bytes: number;
      };
    }
  | {
      readonly state: "running" | "failed";
      readonly jobId: string;
      readonly usage: {
        readonly items: number;
        readonly requests: number;
        readonly bytes: number;
      };
    }
  | {
      readonly state: "idle";
      readonly jobId?: string;
      readonly usage: {
        readonly items: number;
        readonly requests: number;
        readonly bytes: number;
      };
    };

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resultObject = (value: unknown): JsonObject => {
  if (!object(value)) return invalidResult();
  return value;
};

const text = (value: unknown): value is string => typeof value === "string";
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const knownVersions = (
  sourceGeneration: string,
  projectionGeneration: string | null,
) => ({
  schemaVersion,
  storageVersion,
  projectionGeneration,
  sourceGeneration,
});

const projectedVersions = (
  sourceGeneration: string,
  projectionGeneration: string,
) => ({
  schemaVersion,
  storageVersion,
  projectionGeneration,
  sourceGeneration,
});

const sourceVersions = (sourceGeneration: string) => ({
  schemaVersion,
  storageVersion,
  projectionGeneration: null,
  sourceGeneration,
});

const unknownVersions = () => ({
  schemaVersion: null,
  storageVersion: null,
  projectionGeneration: null,
  sourceGeneration: null,
});

const digestHex = async (value: string): Promise<string> =>
  Array.from(await getInsightsInstallationOrderKey(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const jsStringOrderKey = (value: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    result += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return result;
};

const legacyAliases = (value: unknown): JsonObject[] => {
  if (!object(value) || !text(value.id) || !canonicalUuid.test(value.id))
    return invalidResult();
  if (value.oversized === true) return [{ id: value.id, invalid: true }];
  if (
    !text(value.installId) ||
    !(value.userId === null || text(value.userId)) ||
    !(value.username === null || text(value.username)) ||
    !object(value.event)
  )
    return invalidResult();
  const row = value.event as unknown as BundleEventRow;
  let eventBytes: number;
  try {
    assertInsightsEventContract(row);
    eventBytes = getCanonicalInsightsJsonByteLength(row);
  } catch {
    return [{ id: value.id, invalid: true }];
  }
  if (
    row.id !== value.id ||
    row.install_id !== value.installId ||
    row.user_id !== value.userId ||
    row.username !== value.username
  )
    return [{ id: value.id, invalid: true }];
  const originals = [row.install_id, row.user_id, row.username].filter(
    (alias): alias is string => alias !== null,
  );
  if (originals.some((alias) => alias.length > 1024)) {
    return [{ id: value.id, invalid: true }];
  }
  return [
    {
      id: value.id,
      eventBytes,
      aliases: [
        {
          kind: "installationId",
          original: row.install_id,
          normalized: row.install_id.toLowerCase(),
        },
        ...(row.user_id === null
          ? []
          : [
              {
                kind: "userId",
                original: row.user_id,
                normalized: row.user_id.toLowerCase(),
              },
            ]),
        ...(row.username === null
          ? []
          : [
              {
                kind: "username",
                original: row.username,
                normalized: row.username.toLowerCase(),
              },
            ]),
      ],
    },
  ];
};

const boundedLegacyBatch = (
  value: unknown,
  maxBytes = INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
): JsonObject[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000)
    return invalidResult();
  const batch: JsonObject[] = [];
  let bytes = 2;
  for (const row of value) {
    const [item] = legacyAliases(row);
    const itemBytes = getCanonicalInsightsJsonByteLength(item);
    const nextBytes = bytes + (batch.length === 0 ? 0 : 1) + itemBytes;
    if (nextBytes > maxBytes) break;
    batch.push(item);
    bytes = nextBytes;
  }
  return batch;
};

const encodeCursor = (value: unknown): string => {
  const cursor = JSON.stringify(value);
  assertInsightsCursorContract(cursor);
  return cursor;
};

const decodeCursor = (cursor: string | undefined): unknown => {
  if (cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(cursor);
    return JSON.parse(cursor);
  } catch {
    return invalidQuery();
  }
};

const sourceGeneration = (value: unknown): string => {
  if (!text(value) || value.length > 1024) invalidResult();
  return value as string;
};

const throwMaintenanceError = (
  operation: string,
  error: PostgrestError | null,
): void => {
  if (error?.message === "INSIGHTS_DATABASE_NAMESPACE_MISMATCH") {
    throw new InsightsQueryNotReadyError();
  }
  throwSupabaseError(operation, error);
};

export const readSupabaseInsightsDatabaseNamespace = (
  value: unknown,
): string => {
  if (!text(value) || !canonicalDatabaseNamespace.test(value)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  return value;
};

export const createSupabaseInsightsMaintenance = (
  supabase: RpcClient,
  databaseNamespace: string,
) => {
  databaseNamespace = readSupabaseInsightsDatabaseNamespace(databaseNamespace);
  const runJobStep = async (
    jobId: string,
    input: SupabaseInsightsMaintenanceInput,
  ): Promise<SupabaseInsightsMaintenanceResult> => {
    try {
      assertInsightsMaintenanceInputContract({
        maxItems: input.maxItems,
        maxRequests: input.maxRequests,
      });
    } catch {
      return invalidQuery();
    }
    const maxBytes = input.maxBytes ?? INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES ||
      !text(jobId) ||
      jobId.length === 0 ||
      jobId.length > 128
    )
      invalidQuery();

    const failed = (requests: number): SupabaseInsightsMaintenanceResult => ({
      state: "failed",
      jobId,
      usage: { items: 0, requests, bytes: 0 },
    });
    if (jobId === "supabase-v2-migration") {
      if (input.maxRequests < 2) {
        return {
          state: "idle",
          jobId,
          usage: { items: 0, requests: 0, bytes: 0 },
        };
      }
      const { data: readData, error: readError } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsPrepareRead,
        {
          p_database_namespace: databaseNamespace,
          p_max_items: Math.min(input.maxItems, 1000),
        } as never,
      );
      throwMaintenanceError("read Supabase Insights migration step", readError);
      const read = resultObject(readData);
      if (!text(read.state)) invalidResult();
      if (read.state === "ready") {
        return {
          state: "complete",
          publicationId: jobId,
          usage: { items: 0, requests: 1, bytes: 0 },
        };
      }
      if (read.state === "failed") return failed(1);
      if (read.state !== "preparing" || !Array.isArray(read.batch))
        invalidResult();
      const batch = boundedLegacyBatch(read.batch, maxBytes);
      if (batch.length === 0) {
        return {
          state: "idle",
          jobId,
          usage: { items: 0, requests: 1, bytes: 0 },
        };
      }
      const bytes = getCanonicalInsightsJsonByteLength(batch);
      const { data: commitData, error: commitError } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsPrepare,
        {
          p_database_namespace: databaseNamespace,
          p_max_items: Math.min(input.maxItems, 1000),
          p_batch: batch,
          p_batch_bytes: bytes,
        } as never,
      );
      throwMaintenanceError(
        "commit Supabase Insights migration step",
        commitError,
      );
      const commit = resultObject(commitData);
      if (
        !text(commit.state) ||
        (commit.processed !== undefined && !integer(commit.processed))
      )
        invalidResult();
      const processed = (commit.processed as number | undefined) ?? 0;
      if (processed > input.maxItems || processed > batch.length)
        invalidResult();
      const usage = { items: processed, requests: 2, bytes };
      if (commit.state === "ready") {
        return { state: "complete", publicationId: jobId, usage };
      }
      if (commit.state === "preparing") {
        return { state: "running", jobId, usage };
      }
      if (commit.state === "failed") {
        return { state: "failed", jobId, usage };
      }
      return invalidResult();
    }

    const retention = /^supabase-v2-retention:(0|[1-9][0-9]*)$/.exec(jobId);
    if (retention !== null) {
      const beforeMs = Number(retention[1]);
      if (!integer(beforeMs) || beforeMs > 9007199254740991) invalidQuery();
      const { data, error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsPrune,
        {
          p_database_namespace: databaseNamespace,
          p_before_ms: beforeMs,
          p_max_items: input.maxItems,
          p_max_bytes: maxBytes,
        } as never,
      );
      throwMaintenanceError("prune Supabase Insights publications", error);
      const payload = resultObject(data);
      if (
        !text(payload.state) ||
        !integer(payload.processed) ||
        payload.processed > input.maxItems ||
        !integer(payload.bytes) ||
        payload.bytes > maxBytes
      )
        invalidResult();
      const usage = {
        items: payload.processed as number,
        requests: 1,
        bytes: payload.bytes as number,
      };
      if (payload.state === "complete") {
        return { state: "complete", publicationId: jobId, usage };
      }
      if (payload.state === "running") {
        return { state: "running", jobId, usage };
      }
      return invalidResult();
    }

    const functionName = jobId.startsWith("search:")
      ? SUPABASE_V1_FUNCTION_NAMES.insightsSearchStep
      : jobId.startsWith("report:")
        ? SUPABASE_V1_FUNCTION_NAMES.insightsReportStep
        : null;
    if (functionName === null) return failed(0);
    const { data, error } = await supabase.rpc(functionName, {
      p_database_namespace: databaseNamespace,
      p_job_id: jobId,
      p_max_items: input.maxItems,
      p_max_bytes: maxBytes,
    } as never);
    throwMaintenanceError("run Supabase Insights job step", error);
    const payload = resultObject(data);
    if (
      !text(payload.state) ||
      !integer(payload.processed) ||
      payload.processed > input.maxItems ||
      !integer(payload.bytes) ||
      payload.bytes > maxBytes
    )
      invalidResult();
    const usage = {
      items: payload.processed as number,
      requests: 1,
      bytes: payload.bytes as number,
    };
    if (payload.state === "complete") {
      if (!text(payload.publicationId)) invalidResult();
      return {
        state: "complete",
        publicationId: payload.publicationId as string,
        usage,
      };
    }
    if (payload.state === "running" || payload.state === "failed") {
      if (!text(payload.jobId) || payload.jobId !== jobId) invalidResult();
      return { state: payload.state, jobId, usage };
    }
    return invalidResult();
  };

  return {
    runJobStep,
    async runScheduledStep(
      input: SupabaseInsightsMaintenanceInput,
    ): Promise<SupabaseInsightsMaintenanceResult> {
      try {
        assertInsightsMaintenanceInputContract({
          maxItems: input.maxItems,
          maxRequests: input.maxRequests,
        });
      } catch {
        return invalidQuery();
      }
      const maxBytes = input.maxBytes ?? INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES;
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
      )
        invalidQuery();

      const { data, error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsJobNext,
        { p_database_namespace: databaseNamespace } as never,
      );
      throwMaintenanceError(
        "discover Supabase Insights maintenance job",
        error,
      );
      const payload = resultObject(data);
      if (payload.state === "idle") {
        return {
          state: "idle",
          usage: { items: 0, requests: 1, bytes: 0 },
        };
      }
      if (
        payload.state !== "queued" ||
        !text(payload.jobId) ||
        payload.jobId.length === 0 ||
        payload.jobId.length > 128
      )
        invalidResult();
      const jobId = payload.jobId as string;
      if (input.maxRequests === 1) {
        return {
          state: "idle",
          jobId,
          usage: { items: 0, requests: 1, bytes: 0 },
        };
      }
      const result = await runJobStep(jobId, {
        ...input,
        maxRequests: input.maxRequests - 1,
      });
      return {
        ...result,
        usage: { ...result.usage, requests: result.usage.requests + 1 },
      };
    },
  };
};

const mapReadError = (
  operation: string,
  error: { code?: string; message?: string } | null,
) => {
  if (error === null) return null;
  if (error.code === "22023") {
    throw new DatabasePluginInputError("invalid-query");
  }
  const missing =
    error.code === "PGRST202" ||
    (error.code === "42883" &&
      error.message?.includes("hot_updater_v1_insights_"));
  const marker = error.message ?? "";
  if (
    missing ||
    marker === "INSIGHTS_STORAGE_NOT_READY" ||
    marker === "INSIGHTS_DATABASE_NAMESPACE_MISMATCH"
  ) {
    return {
      state: "failed" as const,
      versions: unknownVersions(),
      error: {
        code: missing ? "schema-not-ready" : "storage-not-ready",
      } as const,
    };
  }
  if (marker === "INSIGHTS_MIGRATION_POISON") {
    return {
      state: "failed" as const,
      versions: unknownVersions(),
      error: {
        code: "migration-poison",
        jobId: "supabase-v2-migration",
      } as const,
    };
  }
  if (marker === "INSIGHTS_STORAGE_CORRUPTION") {
    return {
      state: "failed" as const,
      versions: unknownVersions(),
      error: { code: "storage-corruption" } as const,
    };
  }
  throwSupabaseError(operation, error as never);
  return null;
};

const toInstallationRow = (value: unknown): InsightsInstallationRow => {
  if (!object(value)) invalidResult();
  const row = value as unknown as InsightsInstallationRow;
  if (
    !canonicalEventId.test(row.id) ||
    !text(row.install_id) ||
    !(row.user_id === null || text(row.user_id)) ||
    !(row.username === null || text(row.username)) ||
    !canonicalUuid.test(row.to_bundle_id) ||
    !text(row.type) ||
    !text(row.platform) ||
    !text(row.app_version) ||
    !text(row.channel) ||
    !text(row.cohort) ||
    !integer(row.received_at_ms)
  )
    invalidResult();
  return row;
};

const reportPublication = (
  value: unknown,
  input: InsightsReportInput,
): InsightsReportPublication => {
  if (!object(value)) invalidResult();
  const publication = value as unknown as InsightsReportPublication;
  if (
    !text(publication.id) ||
    !integer(publication.asOfMs) ||
    !integer(publication.completedAtMs) ||
    publication.completedAtMs < publication.asOfMs ||
    !text(publication.sourceGeneration) ||
    publication.accuracy !== "exact" ||
    publication.kind !== input.query.kind ||
    (publication.kind === "bundleSummaries"
      ? !Array.isArray(publication.summary)
      : !object(publication.summary))
  )
    invalidResult();
  if (publication.kind === "bundleSummaries") {
    const bundleIds =
      input.query.kind === "bundleSummaries" ? input.query.bundleIds : [];
    if (
      !Array.isArray(publication.summary) ||
      publication.summary.length !== bundleIds.length ||
      publication.summary.some(
        (row, index) =>
          !object(row) ||
          row.bundleId !== bundleIds[index] ||
          !integer(row.installed) ||
          !integer(row.recovered),
      )
    )
      invalidResult();
  } else if (
    publication.kind === "bundleDetail" &&
    (!integer(publication.summary.installed) ||
      !integer(publication.summary.recovered))
  ) {
    invalidResult();
  } else if (
    publication.kind === "installationOverview" &&
    !integer(publication.summary.trackedInstallations)
  ) {
    invalidResult();
  } else if (
    publication.kind === "activeOverview" &&
    !integer(publication.summary.activeInstallations)
  ) {
    invalidResult();
  }
  return publication;
};

const normalizeReportInput = (
  input: InsightsReportInput,
): InsightsReportInput => {
  const normalized = readInsightsReportQuery(input);
  input = {
    query: normalized.query,
    ...(normalized.minAsOfMs === undefined
      ? {}
      : { minAsOfMs: normalized.minAsOfMs }),
  };
  switch (input.query.kind) {
    case "bundleSummaries": {
      const bundleIds = [...new Set(input.query.bundleIds)].sort();
      if (
        bundleIds.length > 100 ||
        bundleIds.some((id) => !canonicalUuid.test(id)) ||
        !["24h", "7d", "30d", "all"].includes(input.query.window)
      )
        invalidQuery();
      return { ...input, query: { ...input.query, bundleIds } };
    }
    case "bundleDetail":
      if (
        !canonicalUuid.test(input.query.bundleId) ||
        !["24h", "7d", "30d", "all"].includes(input.query.window)
      )
        invalidQuery();
      return input;
    case "installationOverview":
      return input;
    case "activeOverview":
      if (!["24h", "7d", "30d"].includes(input.query.window)) invalidQuery();
      return input;
  }
};

const eventSelector = (input: InsightsPageEventsInput) => {
  switch (input.selector.kind) {
    case "all":
      return { scope: "all", scopeId: null } as const;
    case "installationId":
      return {
        scope: "installation",
        scopeId: input.selector.installId,
      } as const;
    case "bundleId":
      if (!canonicalUuid.test(input.selector.bundleId)) invalidQuery();
      return { scope: "bundle", scopeId: input.selector.bundleId } as const;
  }
};

const eventCursor = (
  namespace: string,
  input: InsightsPageEventsInput,
): { receivedAtMs: number; id: string } | undefined => {
  const decoded = decodeCursor(input.cursor);
  if (decoded === undefined) return undefined;
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 8 ||
    decoded[0] !== 1 ||
    decoded[1] !== namespace ||
    decoded[2] !== "events" ||
    JSON.stringify(decoded[3]) !== JSON.stringify(input.selector) ||
    decoded[4] !== (input.sinceReceivedAtMs ?? 0) ||
    decoded[5] !== input.beforeReceivedAtMs ||
    !integer(decoded[6]) ||
    !text(decoded[7]) ||
    !canonicalEventId.test(decoded[7])
  )
    invalidQuery();
  const values = decoded as unknown[];
  return { receivedAtMs: values[6] as number, id: values[7] as string };
};

export const createSupabaseInsights = (
  supabase: RpcClient,
  databaseNamespace: string,
  nowMs: () => number = Date.now,
): InsightsModel => {
  const namespace = readSupabaseInsightsDatabaseNamespace(databaseNamespace);
  const maintenance = createSupabaseInsightsMaintenance(supabase, namespace);
  let storagePrepared = false;

  const inspectStorage = async (projectionGeneration: string | null) => {
    if (storagePrepared) return null;
    const { data, error } = await supabase.rpc(
      SUPABASE_V1_FUNCTION_NAMES.insightsPrepareRead,
      { p_database_namespace: namespace, p_max_items: 0 } as never,
    );
    const failure = mapReadError("inspect Supabase Insights storage", error);
    if (failure !== null) return failure;
    const payload = resultObject(data);
    if (!text(payload.state)) invalidResult();
    const generation = sourceGeneration(payload.sourceGeneration);
    if (payload.state === "ready") {
      storagePrepared = true;
      return null;
    }
    if (!text(payload.jobId)) return invalidResult();
    if (payload.state === "preparing") {
      return {
        state: "preparing" as const,
        versions: knownVersions(generation, projectionGeneration),
        job: { id: payload.jobId },
      };
    }
    if (payload.state === "failed") {
      return {
        state: "failed" as const,
        versions: knownVersions(generation, projectionGeneration),
        error: {
          code: "migration-poison" as const,
          jobId: payload.jobId,
        },
      };
    }
    return invalidResult();
  };

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
    input = readInsightsInstallationPageInput(input);
    const cursorNamespace = namespace;
    if (
      (input.kind === "contains" && input.query.length === 0) ||
      (input.kind === "installationId" && input.cursor !== undefined) ||
      ((input.kind === "contains" || input.kind === "userId") &&
        input.minAsOfMs !== undefined &&
        !integer(input.minAsOfMs)) ||
      ((input.kind === "contains" || input.kind === "userId") &&
        input.publicationId !== undefined &&
        (input.publicationId.length === 0 || input.publicationId.length > 128))
    )
      invalidQuery();
    const decoded = decodeCursor(input.cursor);
    if (
      decoded !== undefined &&
      (!Array.isArray(decoded) ||
        decoded.length !==
          (input.kind === "contains" || input.kind === "userId" ? 8 : 7) ||
        decoded[0] !== 1 ||
        decoded[1] !== cursorNamespace ||
        decoded[2] !== "installations" ||
        decoded[3] !== installationOrderRevision ||
        JSON.stringify(decoded[4]) !==
          JSON.stringify(
            input.kind === "contains"
              ? { kind: input.kind, query: input.query }
              : input.kind === "userId"
                ? { kind: input.kind, userId: input.userId }
                : input.kind === "installationId"
                  ? { kind: input.kind, installId: input.installId }
                  : { kind: input.kind },
          ) ||
        !(decoded[5] === null || text(decoded[5])) ||
        !(decoded[6] === null || text(decoded[6])) ||
        ((input.kind === "contains" || input.kind === "userId") &&
          (!text(decoded[7]) ||
            !/^(0|[1-9][0-9]*)$/.test(decoded[7]) ||
            decoded[7].length > 16)))
    )
      invalidQuery();
    if (
      Array.isArray(decoded) &&
      (!text(decoded[6]) ||
        !/^[0-9a-f]{64}$/.test(decoded[6]) ||
        (input.kind === "all" && decoded[5] !== null) ||
        ((input.kind === "contains" || input.kind === "userId") &&
          (!text(decoded[5]) ||
            decoded[5].length === 0 ||
            decoded[5].length > 128)))
    )
      invalidQuery();
    const selector =
      input.kind === "contains"
        ? { kind: input.kind, query: input.query.toLowerCase() }
        : input.kind === "userId"
          ? { kind: input.kind, userId: input.userId }
          : input.kind === "installationId"
            ? { kind: input.kind, installId: input.installId }
            : { kind: input.kind };
    const cursorPublicationId =
      Array.isArray(decoded) && text(decoded[5]) ? decoded[5] : undefined;
    if (
      (input.kind === "contains" || input.kind === "userId") &&
      input.publicationId !== undefined &&
      cursorPublicationId !== undefined &&
      input.publicationId !== cursorPublicationId
    )
      invalidQuery();
    if (input.kind === "all" || input.kind === "installationId") {
      const preparation = await inspectStorage(null);
      if (preparation !== null) return preparation;
    }
    const { data, error } = await supabase.rpc(
      SUPABASE_V1_FUNCTION_NAMES.insightsInstallationPage,
      {
        p_database_namespace: namespace,
        p_selector: selector,
        p_limit: input.limit,
        p_after_key: Array.isArray(decoded) ? decoded[6] : null,
        p_after_ordinal:
          Array.isArray(decoded) && text(decoded[7]) ? decoded[7] : null,
        p_publication_id:
          input.kind === "contains" || input.kind === "userId"
            ? (input.publicationId ??
              (Array.isArray(decoded) && text(decoded[5]) ? decoded[5] : null))
            : Array.isArray(decoded) && text(decoded[5])
              ? decoded[5]
              : null,
        p_min_as_of_ms:
          input.kind === "contains" || input.kind === "userId"
            ? Array.isArray(decoded)
              ? null
              : (input.minAsOfMs ?? null)
            : null,
        p_now_ms: nowMs(),
      } as never,
    );
    const failure = mapReadError("page Insights installations", error);
    if (failure !== null) return failure;
    if (!object(data) || !text(data.state)) invalidResult();
    const payload = data as JsonObject;
    if (payload.state === "expired") {
      if (!text(payload.publicationId)) invalidResult();
      return {
        state: "expired",
        publicationId: payload.publicationId as string,
      };
    }
    const generation = sourceGeneration(payload.sourceGeneration);
    if (payload.state === "preparing") {
      if (!text(payload.jobId)) invalidResult();
      return {
        state: "preparing",
        versions: knownVersions(generation, generation),
        job: { id: payload.jobId as string },
      };
    }
    if (payload.state === "failed") {
      if (!text(payload.jobId)) invalidResult();
      return {
        state: "failed",
        versions: knownVersions(generation, generation),
        error: {
          code:
            payload.error === "migration-poison"
              ? "migration-poison"
              : "preparation-failed",
          jobId: payload.jobId as string,
        },
      };
    }
    const readState = payload.state;
    if (
      (readState !== "ready" && readState !== "stale") ||
      !Array.isArray(payload.rows) ||
      payload.rows.length > input.limit ||
      typeof payload.hasMore !== "boolean" ||
      !text(payload.consistency) ||
      (!text(payload.lastKey) && payload.lastKey !== null) ||
      (payload.consistency === "snapshot" &&
        !(
          payload.lastOrdinal === null ||
          (text(payload.lastOrdinal) &&
            /^(0|[1-9][0-9]*)$/.test(payload.lastOrdinal) &&
            payload.lastOrdinal.length <= 16)
        )) ||
      (readState === "stale" && !text(payload.refreshJobId))
    )
      invalidResult();
    const rows = (payload.rows as unknown[]).map(toInstallationRow);
    if (input.kind === "installationId" && (rows.length > 1 || payload.hasMore))
      invalidResult();
    const afterKey =
      Array.isArray(decoded) && text(decoded[6]) ? decoded[6] : null;
    let previousKey = afterKey;
    for (const row of rows) {
      const key = await digestHex(row.install_id);
      if (
        (previousKey !== null && key <= previousKey) ||
        (input.kind === "installationId" && row.install_id !== input.installId)
      )
        invalidResult();
      previousKey = key;
    }
    if (
      rows.length > 0 &&
      (!text(payload.lastKey) ||
        payload.lastKey !== (await digestHex(rows.at(-1)!.install_id)))
    )
      invalidResult();
    const previousOrdinal =
      Array.isArray(decoded) && text(decoded[7]) ? Number(decoded[7]) : -1;
    if (
      payload.consistency === "snapshot" &&
      ((rows.length === 0 && payload.lastOrdinal !== null) ||
        (rows.length > 0 &&
          payload.lastOrdinal !== String(previousOrdinal + rows.length)))
    )
      invalidResult();
    const publication = payload.publication;
    if (
      payload.consistency === "snapshot" &&
      (!object(publication) ||
        !text(publication.id) ||
        !integer(publication.asOfMs) ||
        !integer(publication.completedAtMs) ||
        publication.completedAtMs < publication.asOfMs)
    )
      invalidResult();
    if (payload.consistency === "live" && !integer(payload.observedAtMs))
      invalidResult();
    const cursorSelector =
      input.kind === "contains"
        ? { kind: input.kind, query: input.query }
        : input.kind === "userId"
          ? { kind: input.kind, userId: input.userId }
          : input.kind === "installationId"
            ? { kind: input.kind, installId: input.installId }
            : { kind: input.kind };
    const nextCursor =
      payload.hasMore && text(payload.lastKey)
        ? encodeCursor([
            1,
            cursorNamespace,
            "installations",
            installationOrderRevision,
            cursorSelector,
            payload.consistency === "snapshot" && object(publication)
              ? publication.id
              : null,
            payload.lastKey,
            ...(payload.consistency === "snapshot"
              ? [payload.lastOrdinal]
              : []),
          ])
        : null;
    if (payload.hasMore && nextCursor === null) invalidResult();
    const exactTotal = integer(payload.total)
      ? {
          state: "exact" as const,
          value: payload.total as number,
          sourceGeneration: generation,
        }
      : ({ state: "unavailable" } as const);
    const result = {
      state: readState,
      versions: projectedVersions(generation, generation),
      data: {
        data: rows,
        nextCursor,
        hasNext: nextCursor !== null,
        consistency:
          payload.consistency === "snapshot" && object(publication)
            ? {
                kind: "snapshot",
                cutoff: {
                  kind: "publication",
                  publication: {
                    id: publication.id as string,
                    asOfMs: publication.asOfMs as number,
                    completedAtMs: publication.completedAtMs as number,
                    sourceGeneration: generation,
                    accuracy: "exact",
                  },
                },
              }
            : {
                kind: "live",
                cutoff: {
                  kind: "projection",
                  observedAtMs: payload.observedAtMs as number,
                  projectionGeneration: generation,
                },
              },
        total: exactTotal,
      },
      ...(readState === "stale"
        ? { refresh: { id: payload.refreshJobId as string } }
        : {}),
    } as unknown as InsightsInstallationPage;
    assertInsightsPageContract(result, input.limit);
    return result;
  }

  const model: InsightsModel = {
    async append(row: BundleEventRow): Promise<void> {
      try {
        assertInsightsEventContract(row);
      } catch {
        throw new DatabasePluginInputError("invalid-data");
      }
      const aliases = [
        {
          kind: "installationId",
          original: row.install_id,
          normalized: row.install_id.toLowerCase(),
        },
        ...(row.user_id === null
          ? []
          : [
              {
                kind: "userId",
                original: row.user_id,
                normalized: row.user_id.toLowerCase(),
              },
            ]),
        ...(row.username === null
          ? []
          : [
              {
                kind: "username",
                original: row.username,
                normalized: row.username.toLowerCase(),
              },
            ]),
      ];
      const { error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsAppend,
        {
          p_database_namespace: namespace,
          p_event: row,
          p_event_bytes: getCanonicalInsightsJsonByteLength(row),
          p_install_key: await digestHex(row.install_id),
          p_cohort_order: jsStringOrderKey(row.cohort),
          p_aliases: aliases,
        } as never,
      );
      if (
        error?.code === "PGRST202" ||
        error?.code === "42883" ||
        error?.message === "INSIGHTS_STORAGE_NOT_READY" ||
        error?.message === "INSIGHTS_DATABASE_NAMESPACE_MISMATCH"
      )
        throw new InsightsQueryNotReadyError();
      if (error?.code === "22023") {
        throw new DatabasePluginInputError("invalid-data");
      }
      throwSupabaseError("append Insights event", error);
    },

    async runMaintenanceStep({ jobId, maxItems, maxRequests }) {
      await maintenance.runJobStep(jobId, { maxItems, maxRequests });
    },

    async pageEvents(
      input: InsightsPageEventsInput,
    ): Promise<InsightsPageEventsResult> {
      input = readInsightsPageEventsInput(input);
      const cursorNamespace = namespace;
      const selector = eventSelector(input);
      const cursor = eventCursor(cursorNamespace, input);
      const preparation = await inspectStorage(null);
      if (preparation !== null) return preparation;
      const { data, error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsEventPage,
        {
          p_database_namespace: namespace,
          p_scope: selector.scope,
          p_scope_id: selector.scopeId,
          p_before_received_at_ms: input.beforeReceivedAtMs,
          p_since_received_at_ms: input.sinceReceivedAtMs ?? 0,
          p_limit: input.limit,
          p_cursor_received_at_ms: cursor?.receivedAtMs ?? null,
          p_cursor_id: cursor?.id ?? null,
        } as never,
      );
      const failure = mapReadError("page Insights events", error);
      if (failure !== null) return failure;
      if (
        !object(data) ||
        !Array.isArray(data.rows) ||
        data.rows.length > input.limit ||
        typeof data.hasMore !== "boolean" ||
        !text(data.sourceGeneration)
      )
        invalidResult();
      const payload = data as JsonObject;
      const generation = sourceGeneration(payload.sourceGeneration);
      const rows = payload.rows as BundleEventRow[];
      for (const [index, row] of rows.entries()) {
        assertInsightsEventContract(row);
        const previous = rows[index - 1];
        if (
          row.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
          row.received_at_ms >= input.beforeReceivedAtMs ||
          (cursor !== undefined &&
            (row.received_at_ms > cursor.receivedAtMs ||
              (row.received_at_ms === cursor.receivedAtMs &&
                row.id >= cursor.id))) ||
          (previous !== undefined &&
            (previous.received_at_ms < row.received_at_ms ||
              (previous.received_at_ms === row.received_at_ms &&
                previous.id <= row.id))) ||
          (input.selector.kind === "installationId" &&
            (row.install_id !== input.selector.installId ||
              (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED"))) ||
          (input.selector.kind === "bundleId" &&
            !(
              (row.type === "UPDATE_APPLIED" &&
                row.to_bundle_id === input.selector.bundleId) ||
              (row.type === "RECOVERED" &&
                row.from_bundle_id === input.selector.bundleId)
            ))
        )
          invalidResult();
      }
      const last = rows.at(-1);
      if (payload.hasMore && last === undefined) invalidResult();
      const nextCursor =
        payload.hasMore && last
          ? encodeCursor([
              1,
              cursorNamespace,
              "events",
              input.selector,
              input.sinceReceivedAtMs ?? 0,
              input.beforeReceivedAtMs,
              last.received_at_ms,
              last.id,
            ])
          : null;
      const result: InsightsPageEventsResult = {
        state: "ready",
        versions: sourceVersions(generation),
        data: {
          data: rows,
          nextCursor,
          hasNext: nextCursor !== null,
          consistency: {
            kind: "live",
            cutoff: {
              kind: "event-time",
              beforeReceivedAtMs: input.beforeReceivedAtMs,
            },
          },
          total: { state: "unavailable" },
        },
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    },

    pageInstallations,

    async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
      const normalized = normalizeReportInput(input);
      const { data, error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsReport,
        {
          p_database_namespace: namespace,
          p_query: normalized.query,
          p_min_as_of_ms: normalized.minAsOfMs ?? null,
          p_now_ms: nowMs(),
        } as never,
      );
      const failure = mapReadError("get Insights report", error);
      if (failure !== null) return failure;
      if (!object(data) || !text(data.state)) invalidResult();
      const payload = data as JsonObject;
      if (payload.state === "preparing") {
        if (!text(payload.jobId)) invalidResult();
        const generation = sourceGeneration(payload.sourceGeneration);
        const result: InsightsReportResult = {
          state: "preparing",
          versions: projectedVersions(generation, generation),
          job: { id: payload.jobId as string },
        };
        assertInsightsReportResultContract(result);
        return result;
      }
      if (payload.state === "failed") {
        if (!text(payload.jobId)) invalidResult();
        const generation = sourceGeneration(payload.sourceGeneration);
        const result: InsightsReportResult = {
          state: "failed",
          versions: projectedVersions(generation, generation),
          error: {
            code:
              payload.error === "migration-poison"
                ? "migration-poison"
                : "preparation-failed",
            jobId: payload.jobId as string,
          },
        };
        assertInsightsReportResultContract(result);
        return result;
      }
      if (
        (payload.state !== "ready" && payload.state !== "stale") ||
        !object(payload.publication) ||
        (payload.state === "stale" && !text(payload.refreshJobId))
      )
        invalidResult();
      const readState = payload.state as "ready" | "stale";
      const publication = reportPublication(payload.publication, normalized);
      const generation = sourceGeneration(publication.sourceGeneration);
      const result: InsightsReportResult =
        readState === "stale"
          ? {
              state: "stale",
              versions: projectedVersions(generation, generation),
              data: publication,
              refresh: { id: payload.refreshJobId as string },
            }
          : {
              state: "ready",
              versions: projectedVersions(generation, generation),
              data: publication,
            };
      assertInsightsReportResultContract(result);
      return result;
    },

    async pageReport(
      input: InsightsReportPageInput,
    ): Promise<InsightsReportPage> {
      input = readInsightsReportPageInput(input);
      const cursorNamespace = namespace;
      const parsed = readInsightsReportPageQuery(input, cursorNamespace);
      const structural = parsed.input;
      if (
        structural.publicationId.length === 0 ||
        structural.publicationId.length > 1024 ||
        (structural.section === "activeBundleSeries" &&
          structural.bundleId !== undefined &&
          !canonicalUuid.test(structural.bundleId))
      )
        invalidQuery();
      const section =
        structural.section === "movementSeries" ||
        structural.section === "movementCohorts"
          ? { section: structural.section, metric: structural.metric }
          : structural.section === "activeBundleSeries"
            ? {
                section: structural.section,
                bundleId: structural.bundleId ?? null,
              }
            : { section: structural.section };
      const publicSection =
        structural.section === "movementSeries" ||
        structural.section === "movementCohorts"
          ? { section: structural.section, metric: structural.metric }
          : { section: structural.section };
      const { data, error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.insightsReportPage,
        {
          p_database_namespace: namespace,
          p_publication_id: structural.publicationId,
          p_section: section,
          p_limit: structural.limit,
          p_after: input.cursor === undefined ? null : parsed.nextOrdinal,
        } as never,
      );
      const failure = mapReadError("page Insights report", error);
      if (failure !== null) return failure;
      if (!object(data) || !text(data.state)) invalidResult();
      const payload = data as JsonObject;
      if (payload.state === "expired")
        return {
          state: "expired",
          publicationId: structural.publicationId,
        };
      if (
        payload.state !== "ready" ||
        !Array.isArray(payload.rows) ||
        payload.rows.length > input.limit ||
        typeof payload.hasMore !== "boolean" ||
        !object(payload.publication)
      )
        invalidResult();
      const publication = payload.publication as JsonObject;
      const generation = sourceGeneration(publication.sourceGeneration);
      for (const row of payload.rows as unknown[]) {
        if (!object(row)) invalidResult();
        const resultRow = row as JsonObject;
        if (
          (structural.section === "movementSeries" ||
            structural.section === "activeSeries") &&
          (!integer(resultRow.bucketStartMs) || !integer(resultRow.value))
        )
          invalidResult();
        if (
          structural.section === "movementCohorts" &&
          (!text(resultRow.cohort) || !integer(resultRow.value))
        )
          invalidResult();
        if (
          structural.section === "bundleDistribution" &&
          (!text(resultRow.bundleId) ||
            !canonicalUuid.test(resultRow.bundleId) ||
            !integer(resultRow.installations))
        )
          invalidResult();
        if (
          structural.section === "activeBundleSeries" &&
          (!text(resultRow.bundleId) ||
            !canonicalUuid.test(resultRow.bundleId) ||
            !integer(resultRow.bucketStartMs) ||
            !integer(resultRow.value) ||
            (structural.bundleId !== undefined &&
              resultRow.bundleId !== structural.bundleId))
        )
          invalidResult();
      }
      const nextCursor =
        payload.hasMore && payload.last !== undefined && payload.last !== null
          ? createInsightsReportPageCursor(
              input,
              text(payload.last) ? payload.last : invalidResult(),
              cursorNamespace,
            )
          : null;
      if (payload.hasMore && nextCursor === null) invalidResult();
      const result: InsightsReportPage = {
        state: "ready",
        versions: projectedVersions(generation, generation),
        data: {
          ...publicSection,
          data: payload.rows as never,
          nextCursor,
          hasNext: nextCursor !== null,
          consistency: {
            kind: "snapshot",
            cutoff: {
              kind: "publication",
              publication: {
                id: input.publicationId,
                asOfMs: publication.asOfMs as number,
                completedAtMs: publication.completedAtMs as number,
                sourceGeneration: generation,
                accuracy: "exact",
              },
            },
          },
          total: integer(payload.total)
            ? {
                state: "exact",
                value: payload.total as number,
                sourceGeneration: generation,
              }
            : { state: "unavailable" },
        } as never,
      };
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    },
  };
  return model;
};
