import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsFailedRead,
  type InsightsProjectedReadVersions,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsInitialPublishedInstallationPage,
  type InsightsInitialPublishedInstallationPageInput,
  type InsightsPreparingRead,
  type InsightsPinnedInstallationPage,
  type InsightsPinnedInstallationPageInput,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageInput,
  type InsightsPublishedInstallationPageData,
  type InsightsPublishedInstallationContinuation,
  type InsightsPublishedInstallationContinuationInput,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportResult,
  type InsightsModel,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  assertInsightsCursorContract,
  assertInsightsExpiredReadContract,
  assertInsightsFailedReadContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  assertInsightsQueryContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  canonicalInsightsJson,
  createInsightsReportProjection,
  createInsightsReportPageCursor,
  getCanonicalInsightsJsonByteLength,
  isCanonicalInsightsEventId,
  readInsightsReportPageQuery,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor } from "./d1Implementation";
import {
  d1InsightsJobVersions,
  d1InsightsUnavailableVersions,
  getD1InsightsReportPublication,
  getD1InsightsSearchPublication,
  getD1InsightsStoredSourceGeneration,
  readD1InsightsPublishedJob,
  reserveD1InsightsReport,
  reserveD1InsightsSearch,
  type D1InsightsPrivatePublication,
  type D1InsightsSearchQuery,
  type D1InsightsStoredJob,
} from "./d1InsightsJobs";
import {
  createD1InsightsEventPages,
  createD1InsightsInstallationPages,
} from "./d1InsightsPages";
import {
  D1InsightsMigrationPoisonError,
  assertD1InsightsDatabaseNamespace,
  assertD1InsightsLayout,
  createD1InsightsEventInsert,
  d1InsightsInstallKey,
  verifyD1InsightsDatabaseNamespace,
} from "./d1InsightsSource";
import { encodeD1Values } from "./d1Sql";

const MEMBERSHIPS = "private_hot_updater_insights_job_memberships";
const LATEST = "private_hot_updater_insights_job_latest";
const PAGE_ROWS = "private_hot_updater_insights_job_page_rows";
const SECTIONS = "private_hot_updater_insights_job_sections";
const INSTALL_KEY = /^[0-9a-f]{64}$/;

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const only = (value: object, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const unavailable = (code: "storage-not-ready" = "storage-not-ready") => {
  const result: InsightsFailedRead = {
    state: "failed",
    versions: d1InsightsUnavailableVersions(),
    error: { code },
  };
  assertInsightsFailedReadContract(result);
  return result;
};

const migrationPoison = (sourceId: string): InsightsFailedRead => {
  const result: InsightsFailedRead = {
    state: "failed",
    versions: d1InsightsUnavailableVersions(),
    error: { code: "migration-poison", jobId: sourceId },
  };
  assertInsightsFailedReadContract(result);
  return result;
};

const versions = (
  publication: Pick<D1InsightsPrivatePublication, "id" | "sourceGeneration">,
): InsightsProjectedReadVersions =>
  d1InsightsJobVersions(publication.sourceGeneration, publication.id);

const preparing = (job: D1InsightsStoredJob): InsightsPreparingRead => {
  const result: InsightsPreparingRead = {
    state: "preparing",
    versions: d1InsightsJobVersions(
      getD1InsightsStoredSourceGeneration(job),
      job.id,
    ),
    job: { id: job.id },
  };
  assertInsightsPreparingReadContract(result);
  return result;
};

const failed = (
  jobId: string,
  job?: D1InsightsStoredJob,
  code: "preparation-failed" | "migration-poison" = job?.failureCode ??
    "preparation-failed",
): InsightsFailedRead => {
  const result: InsightsFailedRead = {
    state: "failed",
    versions:
      job === undefined
        ? d1InsightsUnavailableVersions()
        : d1InsightsJobVersions(
            getD1InsightsStoredSourceGeneration(job),
            job.id,
          ),
    error: { code, jobId },
  };
  assertInsightsFailedReadContract(result);
  return result;
};

const installationRow = (event: unknown): InsightsInstallationRow => {
  if (!record(event)) return invalidResult();
  const row = {
    id: event.id,
    install_id: event.install_id,
    user_id: event.user_id,
    username: event.username,
    to_bundle_id: event.to_bundle_id,
    type: event.type,
    platform: event.platform,
    app_version: event.app_version,
    channel: event.channel,
    cohort: event.cohort,
    received_at_ms: event.received_at_ms,
  } as InsightsInstallationRow;
  return row;
};

type ParsedSearchInput = {
  readonly query: D1InsightsSearchQuery;
  readonly publicationId: string | undefined;
  readonly afterInstallKey: string | null;
  readonly cursorGeneration: string | null;
  readonly nextOrdinal: number;
};

const searchSemanticKey = (
  query: D1InsightsSearchQuery,
  databaseNamespace: string,
): string =>
  query.kind === "installationContains"
    ? canonicalInsightsJson([
        3,
        databaseNamespace,
        query.kind,
        query.normalizedQuery,
      ])
    : canonicalInsightsJson([3, databaseNamespace, query.kind, query.userId]);

const parseSearchInput = (
  input: InsightsPublishedInstallationPageInput,
  databaseNamespace: string,
): ParsedSearchInput => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    invalidQuery();
  }
  if (
    !record(input) ||
    (input.kind !== "contains" && input.kind !== "userId") ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > INSIGHTS_PAGE_MAX_ROWS ||
    (input.minAsOfMs !== undefined &&
      (!safeInteger(input.minAsOfMs) || input.minAsOfMs < 0)) ||
    (input.publicationId !== undefined &&
      !isCanonicalInsightsEventId(input.publicationId))
  ) {
    return invalidQuery();
  }
  const fields = ["kind", "limit", "cursor", "publicationId", "minAsOfMs"];
  let query: D1InsightsSearchQuery;
  if (input.kind === "contains") {
    fields.push("query");
    if (typeof input.query !== "string" || input.query.length === 0) {
      return invalidQuery();
    }
    query = {
      kind: "installationContains",
      normalizedQuery: input.query.toLowerCase(),
    };
  } else {
    fields.push("userId");
    if (typeof input.userId !== "string") return invalidQuery();
    query = { kind: "installationUserId", userId: input.userId };
  }
  if (!only(input, fields)) return invalidQuery();
  let publicationId = input.publicationId;
  let afterInstallKey: string | null = null;
  let cursorGeneration: string | null = null;
  let nextOrdinal = 0;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") return invalidQuery();
    try {
      assertInsightsCursorContract(input.cursor);
    } catch {
      return invalidQuery();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.cursor);
    } catch {
      return invalidQuery();
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 7 ||
      parsed[0] !== 1 ||
      parsed[1] !== searchSemanticKey(query, databaseNamespace) ||
      !isCanonicalInsightsEventId(parsed[2]) ||
      typeof parsed[3] !== "string" ||
      parsed[3].length > 256 ||
      parsed[4] !== "after-install-key" ||
      typeof parsed[5] !== "string" ||
      !INSTALL_KEY.test(parsed[5]) ||
      !safeInteger(parsed[6]) ||
      (publicationId !== undefined && publicationId !== parsed[2])
    ) {
      return invalidQuery();
    }
    publicationId = parsed[2];
    cursorGeneration = parsed[3];
    afterInstallKey = parsed[5];
    nextOrdinal = parsed[6];
  }
  return {
    query,
    publicationId,
    afterInstallKey,
    cursorGeneration,
    nextOrdinal,
  };
};

const sameSearchQuery = (
  stored: D1InsightsStoredJob["query"],
  expected: D1InsightsSearchQuery,
): boolean =>
  stored.kind === expected.kind &&
  (stored.kind === "installationContains"
    ? stored.normalizedQuery ===
      (
        expected as Extract<
          D1InsightsSearchQuery,
          { kind: "installationContains" }
        >
      ).normalizedQuery
    : stored.kind === "installationUserId" &&
      stored.userId ===
        (
          expected as Extract<
            D1InsightsSearchQuery,
            { kind: "installationUserId" }
          >
        ).userId);

const searchCursor = (
  query: D1InsightsSearchQuery,
  publication: D1InsightsPrivatePublication,
  afterInstallKey: string,
  nextOrdinal: number,
  databaseNamespace: string,
): string => {
  const cursor = canonicalInsightsJson([
    1,
    searchSemanticKey(query, databaseNamespace),
    publication.id,
    publication.sourceGeneration,
    "after-install-key",
    afterInstallKey,
    nextOrdinal,
  ]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    return invalidResult();
  }
  return cursor;
};

const readPublishedSearchPage = async (
  executor: D1Executor,
  input: InsightsPublishedInstallationPageInput,
  parsed: ParsedSearchInput,
  job: D1InsightsStoredJob,
  state: "ready" | "stale",
  databaseNamespace: string,
  refreshId?: string,
): Promise<InsightsPublishedInstallationPage> => {
  if (
    job.status !== "ready" ||
    job.kind !== "search" ||
    !sameSearchQuery(job.query, parsed.query)
  ) {
    return invalidResult();
  }
  const publication = getD1InsightsSearchPublication(job);
  const snapshotPublication = {
    id: publication.id,
    asOfMs: publication.asOfMs,
    completedAtMs: publication.completedAtMs,
    sourceGeneration: publication.sourceGeneration,
    accuracy: publication.accuracy,
  };
  if (
    parsed.cursorGeneration !== null &&
    parsed.cursorGeneration !== publication.sourceGeneration
  ) {
    return invalidQuery();
  }
  if (parsed.nextOrdinal > publication.total) return invalidQuery();
  const rows = await executor.query(
    `SELECT membership.install_key, membership.install_id,
      latest.install_id AS latest_install_id, latest.event_id,
      latest.row_bytes
    FROM ${MEMBERSHIPS} AS membership
    JOIN ${LATEST} AS latest INDEXED BY sqlite_autoindex_private_hot_updater_insights_job_latest_1
      ON latest.job_id = membership.job_id
      AND latest.install_key = membership.install_key
      AND latest.bucket_index = -1
    WHERE membership.job_id = json_extract(?, '$') COLLATE BINARY
      AND membership.count_key = json_extract(?, '$')
      ${
        parsed.afterInstallKey === null
          ? ""
          : "AND membership.install_key > json_extract(?, '$') COLLATE BINARY"
      }
    ORDER BY membership.install_key COLLATE BINARY ASC
    LIMIT json_extract(?, '$')`,
    encodeD1Values([
      job.id,
      canonicalInsightsJson(["search", "", "", -1]),
      ...(parsed.afterInstallKey === null ? [] : [parsed.afterInstallKey]),
      input.limit + 1,
    ]),
  );
  if (rows.length > input.limit + 1) return invalidResult();
  const pointers: {
    installKey: string;
    installId: string;
    eventId: string;
    rowBytes: number;
  }[] = [];
  let previous = parsed.afterInstallKey;
  for (const value of rows) {
    if (
      !record(value) ||
      typeof value.install_key !== "string" ||
      !INSTALL_KEY.test(value.install_key) ||
      typeof value.install_id !== "string" ||
      value.latest_install_id !== value.install_id ||
      !isCanonicalInsightsEventId(value.event_id) ||
      !safeInteger(value.row_bytes) ||
      value.row_bytes < 1 ||
      (previous !== null && value.install_key <= previous)
    ) {
      return invalidResult();
    }
    if ((await d1InsightsInstallKey(value.install_id)) !== value.install_key) {
      return invalidResult();
    }
    previous = value.install_key;
    pointers.push({
      installKey: value.install_key,
      installId: value.install_id,
      eventId: value.event_id,
      rowBytes: value.row_bytes,
    });
  }
  const selected: typeof pointers = [];
  let selectedBytes = 4_096;
  for (const pointer of pointers.slice(0, input.limit)) {
    if (selectedBytes + pointer.rowBytes > INSIGHTS_PAGE_MAX_BYTES) break;
    selected.push(pointer);
    selectedBytes += pointer.rowBytes;
  }
  if (pointers.length > 0 && selected.length === 0) return invalidResult();
  const raw =
    selected.length === 0
      ? []
      : await executor.query(
          `SELECT install_key, install_id, event_id, row_bytes, event_json
          FROM ${LATEST}
          WHERE job_id = json_extract(?, '$') COLLATE BINARY
            AND bucket_index = -1
            AND install_key IN (SELECT value FROM json_each(?))
          LIMIT json_extract(?, '$')`,
          [
            ...encodeD1Values([job.id]),
            JSON.stringify(selected.map(({ installKey }) => installKey)),
            ...encodeD1Values([selected.length]),
          ],
        );
  if (raw.length !== selected.length) return invalidResult();
  const byKey = new Map<string, InsightsInstallationRow>();
  for (const value of raw) {
    if (
      !record(value) ||
      typeof value.install_key !== "string" ||
      typeof value.install_id !== "string" ||
      !isCanonicalInsightsEventId(value.event_id) ||
      !safeInteger(value.row_bytes) ||
      typeof value.event_json !== "string" ||
      byKey.has(value.install_key)
    ) {
      return invalidResult();
    }
    const pointer = selected.find(
      ({ installKey }) => installKey === value.install_key,
    );
    let event: unknown;
    try {
      event = JSON.parse(value.event_json);
    } catch {
      return invalidResult();
    }
    if (
      pointer === undefined ||
      pointer.installId !== value.install_id ||
      pointer.eventId !== value.event_id ||
      pointer.rowBytes !== value.row_bytes ||
      canonicalInsightsJson(event) !== value.event_json ||
      getCanonicalInsightsJsonByteLength(event) !== value.row_bytes ||
      !record(event) ||
      event.install_id !== value.install_id
    ) {
      return invalidResult();
    }
    byKey.set(value.install_key, installationRow(event));
  }
  const data = selected.map((pointer) => ({
    installKey: pointer.installKey,
    row: byKey.get(pointer.installKey) ?? invalidResult(),
  }));
  for (;;) {
    const last = data.at(-1);
    const nextOrdinal = parsed.nextOrdinal + data.length;
    if (nextOrdinal > publication.total) return invalidResult();
    const hasNext = nextOrdinal < publication.total;
    if (hasNext !== pointers.length > data.length) return invalidResult();
    const nextCursor =
      hasNext && last !== undefined
        ? searchCursor(
            parsed.query,
            publication,
            last.installKey,
            nextOrdinal,
            databaseNamespace,
          )
        : null;
    const payload: InsightsPublishedInstallationPageData = {
      data: data.map((value) => value.row),
      nextCursor,
      hasNext,
      consistency: {
        kind: "snapshot",
        cutoff: { kind: "publication", publication: snapshotPublication },
      },
      total: {
        state: "exact",
        value: publication.total,
        sourceGeneration: publication.sourceGeneration,
      },
    };
    const result =
      state === "ready"
        ? ({ state, versions: versions(publication), data: payload } as const)
        : ({
            state,
            versions: versions(publication),
            data: payload,
            refresh: { id: refreshId ?? invalidResult() },
          } as const);
    if (getCanonicalInsightsJsonByteLength(result) <= INSIGHTS_PAGE_MAX_BYTES) {
      assertInsightsPageContract(result, input.limit);
      return result;
    }
    if (data.length <= 1) return invalidResult();
    data.pop();
  }
};

const pagePublishedInstallations = async (
  executor: D1Executor,
  input: InsightsPublishedInstallationPageInput,
  databaseNamespace: string,
): Promise<InsightsPublishedInstallationPage> => {
  const parsed = parseSearchInput(input, databaseNamespace);
  try {
    if (parsed.publicationId !== undefined) {
      const pinned = await readD1InsightsPublishedJob(
        executor,
        parsed.publicationId,
      );
      if (pinned === null) {
        const result = {
          state: "expired",
          publicationId: parsed.publicationId,
        } as const;
        assertInsightsExpiredReadContract(result);
        return result;
      }
      if (pinned.status === "failed") return failed(pinned.id, pinned);
      if (pinned.status !== "ready") {
        const result = {
          state: "expired",
          publicationId: parsed.publicationId,
        } as const;
        assertInsightsExpiredReadContract(result);
        return result;
      }
      if (
        pinned.kind !== "search" ||
        !sameSearchQuery(pinned.query, parsed.query)
      ) {
        const result = {
          state: "expired",
          publicationId: parsed.publicationId,
        } as const;
        assertInsightsExpiredReadContract(result);
        return result;
      }
      const publication = getD1InsightsSearchPublication(pinned);
      if (
        input.minAsOfMs !== undefined &&
        publication.asOfMs < input.minAsOfMs
      ) {
        const result = {
          state: "expired",
          publicationId: parsed.publicationId,
        } as const;
        assertInsightsExpiredReadContract(result);
        return result;
      }
      return readPublishedSearchPage(
        executor,
        input,
        parsed,
        pinned,
        "ready",
        databaseNamespace,
      );
    }
    const reserved = await reserveD1InsightsSearch(
      executor,
      input.kind === "contains"
        ? {
            kind: input.kind,
            query: input.query,
            ...(input.minAsOfMs === undefined
              ? {}
              : { minAsOfMs: input.minAsOfMs }),
          }
        : {
            kind: input.kind,
            userId: input.userId,
            ...(input.minAsOfMs === undefined
              ? {}
              : { minAsOfMs: input.minAsOfMs }),
          },
    );
    if (reserved.state === "ready") {
      const job = await readD1InsightsPublishedJob(
        executor,
        reserved.publication.id,
      );
      return job === null
        ? invalidResult()
        : readPublishedSearchPage(
            executor,
            input,
            parsed,
            job,
            "ready",
            databaseNamespace,
          );
    }
    if (reserved.state === "failed") {
      const active = await readD1InsightsPublishedJob(
        executor,
        reserved.error.jobId,
      );
      return failed(
        reserved.error.jobId,
        active ?? undefined,
        reserved.error.code,
      );
    }
    if (reserved.previous === null) {
      const active = await readD1InsightsPublishedJob(executor, reserved.jobId);
      return active === null ? invalidResult() : preparing(active);
    }
    const previous = await readD1InsightsPublishedJob(
      executor,
      reserved.previous.id,
    );
    return previous === null
      ? invalidResult()
      : readPublishedSearchPage(
          executor,
          input,
          parsed,
          previous,
          "stale",
          databaseNamespace,
          reserved.jobId,
        );
  } catch (error) {
    if (error instanceof D1InsightsMigrationPoisonError) {
      return migrationPoison(error.sourceId);
    }
    if (error instanceof InsightsQueryNotReadyError) return unavailable();
    throw error;
  }
};

const getReport = async (
  executor: D1Executor,
  input: Parameters<InsightsModel["getReport"]>[0],
): Promise<InsightsReportResult> => {
  try {
    const reserved = await reserveD1InsightsReport(executor, input);
    let result: InsightsReportResult;
    if (reserved.state === "ready") {
      result = {
        state: "ready",
        versions: versions(reserved.publication),
        data: reserved.publication,
      };
    } else if (reserved.state === "failed") {
      const active = await readD1InsightsPublishedJob(
        executor,
        reserved.error.jobId,
      );
      result = failed(
        reserved.error.jobId,
        active ?? undefined,
        reserved.error.code,
      );
    } else if (reserved.previous === null) {
      const active = await readD1InsightsPublishedJob(executor, reserved.jobId);
      result = active === null ? invalidResult() : preparing(active);
    } else {
      result = {
        state: "stale",
        versions: versions(reserved.previous),
        data: reserved.previous,
        refresh: { id: reserved.jobId },
      };
    }
    assertInsightsReportResultContract(result);
    return result;
  } catch (error) {
    if (error instanceof D1InsightsMigrationPoisonError) {
      return migrationPoison(error.sourceId);
    }
    if (error instanceof InsightsQueryNotReadyError) return unavailable();
    throw error;
  }
};

const reportSectionKey = (
  input: ReturnType<typeof readInsightsReportPageQuery>["input"],
): string =>
  canonicalInsightsJson([input.section, "metric" in input ? input.metric : ""]);

const pageReport = async (
  executor: D1Executor,
  input: InsightsReportPageInput,
  databaseNamespace: string,
): Promise<InsightsReportPage> => {
  const parsed = readInsightsReportPageQuery(input, databaseNamespace);
  if (!isCanonicalInsightsEventId(parsed.input.publicationId)) invalidQuery();
  try {
    const job = await readD1InsightsPublishedJob(
      executor,
      parsed.input.publicationId,
    );
    if (job === null || job.kind !== "report") {
      const result = {
        state: "expired",
        publicationId: parsed.input.publicationId,
      } as const;
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    if (job.status === "failed") {
      const result = failed(job.id, job);
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    if (job.status !== "ready") {
      const result = {
        state: "expired",
        publicationId: parsed.input.publicationId,
      } as const;
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    const publication = getD1InsightsReportPublication(job);
    const snapshotPublication = {
      id: publication.id,
      asOfMs: publication.asOfMs,
      completedAtMs: publication.completedAtMs,
      sourceGeneration: publication.sourceGeneration,
      accuracy: publication.accuracy,
    };
    const request = parsed.input;
    const valid =
      (job.query.kind === "bundleDetail" &&
        (request.section === "movementSeries" ||
          request.section === "movementCohorts")) ||
      ((job.query.kind === "installationOverview" ||
        job.query.kind === "activeOverview") &&
        request.section === "bundleDistribution") ||
      (job.query.kind === "activeOverview" &&
        (request.section === "activeSeries" ||
          request.section === "activeBundleSeries"));
    if (!valid) invalidQuery();
    const key = reportSectionKey(request);
    const start = BigInt(parsed.nextOrdinal);
    let total: number;
    let filter: { readonly label: string } | null = null;
    if (
      request.section === "activeBundleSeries" &&
      request.bundleId !== undefined
    ) {
      filter = { label: request.bundleId };
      const exists = await executor.query(
        `SELECT 1 AS found FROM ${PAGE_ROWS}
        INDEXED BY private_hot_updater_insights_job_page_filter_idx
        WHERE job_id = json_extract(?, '$') COLLATE BINARY
          AND section_key = json_extract(?, '$')
          AND filter_label = json_extract(?, '$') LIMIT 1`,
        encodeD1Values([job.id, key, request.bundleId]),
      );
      if (exists.length > 1) return invalidResult();
      if (exists.length === 0) {
        total = 0;
      } else {
        if (job.query.kind !== "activeOverview") return invalidResult();
        const projection = createInsightsReportProjection(
          job.query,
          job.asOfMs,
        );
        total =
          Math.floor(
            (projection.lastBucketMs - projection.firstBucketMs!) /
              projection.bucketSizeMs,
          ) + 1;
      }
    } else {
      const totals = await executor.query(
        `SELECT total_rows FROM ${SECTIONS}
        WHERE job_id = json_extract(?, '$') COLLATE BINARY
          AND section_key = json_extract(?, '$') LIMIT 1`,
        encodeD1Values([job.id, key]),
      );
      if (
        totals.length !== 1 ||
        !record(totals[0]) ||
        !safeInteger(totals[0].total_rows)
      ) {
        return invalidResult();
      }
      total = totals[0].total_rows;
    }
    if (start > BigInt(total)) invalidQuery();
    const stored = await executor.query(
      `SELECT ordinal, filter_ordinal, row_bytes, row_json FROM ${PAGE_ROWS}
      ${
        filter === null
          ? ""
          : "INDEXED BY private_hot_updater_insights_job_page_filter_idx"
      }
      WHERE job_id = json_extract(?, '$') COLLATE BINARY
        AND section_key = json_extract(?, '$')
        ${
          filter === null
            ? "AND ordinal >= json_extract(?, '$') ORDER BY ordinal ASC"
            : `AND filter_label = json_extract(?, '$')
              AND filter_ordinal >= json_extract(?, '$')
              ORDER BY filter_ordinal ASC`
        }
      LIMIT json_extract(?, '$')`,
      encodeD1Values([
        job.id,
        key,
        ...(filter === null ? [Number(start)] : [filter.label, Number(start)]),
        input.limit + 1,
      ]),
    );
    if (stored.length > input.limit + 1) return invalidResult();
    const rows: unknown[] = [];
    let expected = Number(start);
    for (const value of stored) {
      if (
        !record(value) ||
        !safeInteger(value.ordinal) ||
        !safeInteger(value.filter_ordinal) ||
        !safeInteger(value.row_bytes) ||
        typeof value.row_json !== "string" ||
        (filter === null ? value.ordinal : value.filter_ordinal) !== expected
      ) {
        return invalidResult();
      }
      let row: unknown;
      try {
        row = JSON.parse(value.row_json);
      } catch {
        return invalidResult();
      }
      if (
        canonicalInsightsJson(row) !== value.row_json ||
        getCanonicalInsightsJsonByteLength(row) !== value.row_bytes
      ) {
        return invalidResult();
      }
      rows.push(row);
      expected += 1;
    }
    const data = rows.slice(0, input.limit);
    for (;;) {
      const next = Number(start) + data.length;
      const hasNext = next < total;
      if (hasNext && data.length === 0) return invalidResult();
      const nextCursor = hasNext
        ? createInsightsReportPageCursor(
            request,
            String(next),
            databaseNamespace,
          )
        : null;
      const payload = {
        data,
        nextCursor,
        hasNext,
        consistency: {
          kind: "snapshot" as const,
          cutoff: {
            kind: "publication" as const,
            publication: snapshotPublication,
          },
        },
        total: {
          state: "exact" as const,
          value: total,
          sourceGeneration: publication.sourceGeneration,
        },
        section: request.section,
        ...("metric" in request ? { metric: request.metric } : {}),
      };
      const result = {
        state: "ready" as const,
        versions: versions(publication),
        data: payload,
      };
      if (
        getCanonicalInsightsJsonByteLength(result) <= INSIGHTS_PAGE_MAX_BYTES
      ) {
        assertInsightsReportPageResultContract(result, input.limit);
        return result;
      }
      if (data.length <= 1) return invalidResult();
      data.pop();
    }
  } catch (error) {
    if (error instanceof D1InsightsMigrationPoisonError) {
      const result = migrationPoison(error.sourceId);
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    if (error instanceof InsightsQueryNotReadyError) {
      const result = unavailable();
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    throw error;
  }
};

export const createD1InsightsModel = (
  executor: D1Executor,
  databaseNamespace: string,
): InsightsModel => {
  assertD1InsightsDatabaseNamespace(databaseNamespace);
  const events = createD1InsightsEventPages(executor, databaseNamespace);
  const live = createD1InsightsInstallationPages(
    executor,
    Date.now,
    databaseNamespace,
  );
  async function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  async function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  async function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  async function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    await verifyD1InsightsDatabaseNamespace(executor, databaseNamespace);
    if (input.kind === "all" || input.kind === "installationId") {
      try {
        return await live.pageInstallations(input);
      } catch (error) {
        if (error instanceof D1InsightsMigrationPoisonError) {
          return migrationPoison(error.sourceId);
        }
        if (error instanceof InsightsQueryNotReadyError) return unavailable();
        throw error;
      }
    }
    return pagePublishedInstallations(executor, input, databaseNamespace);
  }
  return {
    async append(row) {
      await verifyD1InsightsDatabaseNamespace(executor, databaseNamespace);
      await assertD1InsightsLayout(executor);
      const statement = await createD1InsightsEventInsert(row);
      await executor.query(statement.sql, statement.params);
    },
    async pageEvents(input) {
      try {
        await verifyD1InsightsDatabaseNamespace(executor, databaseNamespace);
        return await events.pageEvents(input);
      } catch (error) {
        if (error instanceof D1InsightsMigrationPoisonError) {
          return migrationPoison(error.sourceId);
        }
        if (error instanceof InsightsQueryNotReadyError) return unavailable();
        throw error;
      }
    },
    pageInstallations,
    async getReport(input) {
      await verifyD1InsightsDatabaseNamespace(executor, databaseNamespace);
      return getReport(executor, input);
    },
    async pageReport(input) {
      await verifyD1InsightsDatabaseNamespace(executor, databaseNamespace);
      return pageReport(executor, input, databaseNamespace);
    },
  };
};
