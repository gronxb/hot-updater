import type { BundleEventRow } from "./types/databaseRows";
import type {
  InsightsEventPageData,
  InsightsFailedRead,
  InsightsLiveInstallationPageData,
  InsightsPreparingRead,
  InsightsProjectedReadVersions,
  InsightsPublishedInstallationPageData,
  InsightsPublishedReportPageData,
  InsightsReadyRead,
  InsightsReportPage,
  InsightsReportResult,
  InsightsSourceReadVersions,
  InsightsStaleRead,
} from "./types/insightsQueries";

export const INSIGHTS_INGEST_BODY_MAX_BYTES = 16 * 1024;
export const INSIGHTS_EVENT_MAX_BYTES = 20 * 1024;
export const INSIGHTS_QUERY_MAX_BYTES = 32 * 1024;
export const INSIGHTS_CURSOR_MAX_BYTES = 8 * 1024;
export const INSIGHTS_PAGE_MAX_BYTES = 1024 * 1024;
export const INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES = 4 * 1024 * 1024;
export const INSIGHTS_MAINTENANCE_MAX_ITEMS = 4096;
export const INSIGHTS_MAINTENANCE_MAX_REQUESTS = 4096;
export const INSIGHTS_DEFAULT_PAGE_ROWS = 50;
export const INSIGHTS_PAGE_MAX_ROWS = 100;
export const INSIGHTS_STRING_MAX_CODE_UNITS = 1024;

export const INSIGHTS_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const INSIGHTS_DATABASE_NAMESPACE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type InsightsContractErrorReason =
  | "invalid-json"
  | "invalid-event"
  | "invalid-page"
  | "invalid-maintenance-input"
  | "invalid-response"
  | "installation-identity-collision"
  | "invalid-event-id"
  | "event-too-large"
  | "query-too-large"
  | "cursor-too-large"
  | "page-too-large"
  | "response-too-large"
  | "maintenance-input-too-large"
  | "string-too-long"
  | "unsupported-string"
  | "invalid-unicode";

export class InsightsContractError extends Error {
  readonly name = "InsightsContractError";

  constructor(
    readonly reason: InsightsContractErrorReason,
    readonly actualBytes?: number,
    readonly maxBytes?: number,
  ) {
    super(reason);
  }
}

const assertJsonValue = (value: unknown, seen: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormedInsightsString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new InsightsContractError("invalid-json");
  }
  if (seen.has(value)) {
    throw new InsightsContractError("invalid-json");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Object.keys(value).some(
          (key) =>
            !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length,
        )
      ) {
        throw new InsightsContractError("invalid-json");
      }
      return `[${value.map((item) => assertJsonValue(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InsightsContractError("invalid-json");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new InsightsContractError("invalid-json");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        assertWellFormedInsightsString(key);
        if (key.length > INSIGHTS_STRING_MAX_CODE_UNITS) {
          throw new InsightsContractError("string-too-long");
        }
        return `${JSON.stringify(key)}:${assertJsonValue(Reflect.get(value, key), seen)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

/** Stable UTF-8 JSON used for every public Insights byte limit. */
export const canonicalInsightsJson = (value: unknown): string =>
  assertJsonValue(value, new Set());

export const getCanonicalInsightsJsonByteLength = (value: unknown): number =>
  new TextEncoder().encode(canonicalInsightsJson(value)).byteLength;

export const isCanonicalInsightsEventId = (value: unknown): value is string =>
  typeof value === "string" && INSIGHTS_EVENT_ID_PATTERN.test(value);

export const isCanonicalInsightsDatabaseNamespace = (
  value: unknown,
): value is string =>
  typeof value === "string" && INSIGHTS_DATABASE_NAMESPACE_PATTERN.test(value);

export const assertWellFormedInsightsString = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      throw new InsightsContractError("unsupported-string");
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InsightsContractError("invalid-unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new InsightsContractError("invalid-unicode");
    }
  }
};

const assertInsightsStringLimits = (
  value: unknown,
  cursorFields: readonly string[],
  seen = new Set<object>(),
): void => {
  if (typeof value === "string") {
    assertWellFormedInsightsString(value);
    if (value.length > INSIGHTS_STRING_MAX_CODE_UNITS) {
      throw new InsightsContractError("string-too-long");
    }
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item) =>
        assertInsightsStringLimits(item, cursorFields, seen),
      );
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (cursorFields.includes(key) && item !== null && item !== undefined) {
        assertInsightsCursorContract(item);
      } else {
        assertInsightsStringLimits(item, cursorFields, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
};

const assertByteLimit = (
  value: unknown,
  maxBytes: number,
  reason: InsightsContractErrorReason,
): void => {
  const actualBytes = getCanonicalInsightsJsonByteLength(value);
  if (actualBytes > maxBytes) {
    throw new InsightsContractError(reason, actualBytes, maxBytes);
  }
};

/** Audits the complete enumerable raw record, including provider extensions. */
export function assertInsightsEventContract(
  value: unknown,
): asserts value is BundleEventRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InsightsContractError("invalid-event");
  }
  const row = value as Readonly<Record<string, unknown>>;
  const string = (field: string): boolean => typeof row[field] === "string";
  const nullableString = (field: string): boolean =>
    row[field] === null || string(field);
  if (
    !isCanonicalInsightsEventId(row.id) ||
    ![
      "id",
      "type",
      "install_id",
      "user_id",
      "username",
      "from_bundle_id",
      "from_release_id",
      "to_bundle_id",
      "to_release_id",
      "platform",
      "app_version",
      "channel",
      "cohort",
      "update_strategy",
      "fingerprint_hash",
      "sdk_version",
      "received_at_ms",
    ].every((field) => Object.hasOwn(row, field)) ||
    !string("install_id") ||
    !nullableString("user_id") ||
    !nullableString("username") ||
    !nullableString("from_release_id") ||
    !nullableString("to_release_id") ||
    !string("to_bundle_id") ||
    (row.platform !== "ios" && row.platform !== "android") ||
    !string("app_version") ||
    !string("channel") ||
    !string("cohort") ||
    !nullableString("fingerprint_hash") ||
    !nullableString("sdk_version") ||
    typeof row.received_at_ms !== "number" ||
    !Number.isSafeInteger(row.received_at_ms) ||
    row.received_at_ms < 0 ||
    (row.type === "UNCHANGED"
      ? row.from_bundle_id !== null || row.update_strategy !== null
      : (row.type !== "UPDATE_APPLIED" &&
          row.type !== "RECOVERED" &&
          row.type !== "RELEASE_ADOPTED") ||
        !string("from_bundle_id") ||
        (row.update_strategy !== "fingerprint" &&
          row.update_strategy !== "appVersion"))
  ) {
    throw new InsightsContractError(
      isCanonicalInsightsEventId(row.id) ? "invalid-event" : "invalid-event-id",
    );
  }
  assertInsightsStringLimits(value, []);
  assertByteLimit(value, INSIGHTS_EVENT_MAX_BYTES, "event-too-large");
}

export const assertInsightsQueryContract = (value: unknown): void => {
  assertInsightsStringLimits(value, ["cursor"]);
  const queryValue =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key, item]) => key !== "cursor" && item !== undefined,
          ),
        )
      : value;
  assertByteLimit(queryValue, INSIGHTS_QUERY_MAX_BYTES, "query-too-large");
};

export const assertInsightsCursorContract = (value: unknown): void => {
  if (typeof value !== "string" || value.length === 0) {
    throw new InsightsContractError("invalid-json");
  }
  assertWellFormedInsightsString(value);
  const actualBytes = new TextEncoder().encode(value).byteLength;
  if (actualBytes > INSIGHTS_CURSOR_MAX_BYTES) {
    throw new InsightsContractError(
      "cursor-too-large",
      actualBytes,
      INSIGHTS_CURSOR_MAX_BYTES,
    );
  }
};

type ContractRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is ContractRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnly = (value: ContractRecord, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

const isSafeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isContractString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const assertVersions = (
  value: unknown,
  mode: "committed" | "reserved" | "failed",
): ContractRecord => {
  if (
    !isRecord(value) ||
    !hasOnly(value, [
      "schemaVersion",
      "storageVersion",
      "projectionGeneration",
      "sourceGeneration",
    ]) ||
    (value.schemaVersion !== null && !isContractString(value.schemaVersion)) ||
    (value.storageVersion !== null &&
      !isContractString(value.storageVersion)) ||
    (value.projectionGeneration !== null &&
      !isContractString(value.projectionGeneration)) ||
    (value.sourceGeneration !== null &&
      !isContractString(value.sourceGeneration)) ||
    (mode === "committed" &&
      (!isContractString(value.schemaVersion) ||
        !isContractString(value.storageVersion))) ||
    (mode !== "failed" && !isContractString(value.sourceGeneration))
  ) {
    throw new InsightsContractError("invalid-response");
  }
  return value;
};

const assertJob = (value: unknown): void => {
  if (
    !isRecord(value) ||
    !hasOnly(value, ["id"]) ||
    !isContractString(value.id)
  ) {
    throw new InsightsContractError("invalid-response");
  }
};

const assertFailure = (value: unknown): void => {
  if (!isRecord(value) || !isContractString(value.code)) {
    throw new InsightsContractError("invalid-response");
  }
  if (
    [
      "schema-not-ready",
      "storage-not-ready",
      "index-not-ready",
      "source-not-ready",
      "storage-corruption",
    ].includes(value.code)
  ) {
    if (!hasOnly(value, ["code"])) {
      throw new InsightsContractError("invalid-response");
    }
    return;
  }
  if (
    (value.code !== "preparation-failed" &&
      value.code !== "migration-poison") ||
    !hasOnly(value, ["code", "jobId"]) ||
    !isContractString(value.jobId)
  ) {
    throw new InsightsContractError("invalid-response");
  }
};

const assertPublication = (
  value: unknown,
  sourceGeneration?: string,
  requireReport = false,
): ContractRecord => {
  if (
    !isRecord(value) ||
    !isContractString(value.id) ||
    !isSafeCount(value.asOfMs) ||
    !isSafeCount(value.completedAtMs) ||
    !isContractString(value.sourceGeneration) ||
    value.accuracy !== "exact" ||
    value.completedAtMs < value.asOfMs ||
    (sourceGeneration !== undefined &&
      value.sourceGeneration !== sourceGeneration)
  ) {
    throw new InsightsContractError("invalid-response");
  }
  if (!requireReport) {
    if (
      !hasOnly(value, [
        "id",
        "asOfMs",
        "completedAtMs",
        "sourceGeneration",
        "accuracy",
      ])
    ) {
      throw new InsightsContractError("invalid-response");
    }
    return value;
  }
  if (
    !hasOnly(value, [
      "id",
      "asOfMs",
      "completedAtMs",
      "sourceGeneration",
      "accuracy",
      "kind",
      "summary",
    ]) ||
    (!isRecord(value.summary) && !Array.isArray(value.summary))
  ) {
    throw new InsightsContractError("invalid-response");
  }
  const summary = value.summary;
  switch (value.kind) {
    case "bundleSummaries":
      if (
        !Array.isArray(value.summary) ||
        value.summary.length > 100 ||
        value.summary.some(
          (row) =>
            !isRecord(row) ||
            !hasOnly(row, ["bundleId", "installed", "recovered"]) ||
            !isContractString(row.bundleId) ||
            !isSafeCount(row.installed) ||
            !isSafeCount(row.recovered),
        ) ||
        (value.summary as ContractRecord[]).some(
          (row, index, rows) =>
            index > 0 &&
            (rows[index - 1]!.bundleId as string) >= (row.bundleId as string),
        )
      ) {
        throw new InsightsContractError("invalid-response");
      }
      break;
    case "bundleDetail":
      if (
        !isRecord(summary) ||
        !hasOnly(summary, ["installed", "recovered"]) ||
        !isSafeCount(summary.installed) ||
        !isSafeCount(summary.recovered)
      ) {
        throw new InsightsContractError("invalid-response");
      }
      break;
    case "installationOverview":
      if (
        !isRecord(summary) ||
        !hasOnly(summary, ["trackedInstallations"]) ||
        !isSafeCount(summary.trackedInstallations)
      ) {
        throw new InsightsContractError("invalid-response");
      }
      break;
    case "activeOverview":
      if (
        !isRecord(summary) ||
        !hasOnly(summary, ["activeInstallations"]) ||
        !isSafeCount(summary.activeInstallations)
      ) {
        throw new InsightsContractError("invalid-response");
      }
      break;
    default:
      throw new InsightsContractError("invalid-response");
  }
  return value;
};

const assertTotal = (
  value: unknown,
  sourceGeneration: string,
  exactRequired: boolean,
): void => {
  if (!isRecord(value)) {
    throw new InsightsContractError("invalid-page");
  }
  if (value.state === "exact") {
    if (
      !hasOnly(value, ["state", "value", "sourceGeneration"]) ||
      !isSafeCount(value.value) ||
      value.sourceGeneration !== sourceGeneration
    ) {
      throw new InsightsContractError("invalid-page");
    }
    return;
  }
  if (
    exactRequired ||
    (value.state === "pending"
      ? !hasOnly(value, ["state", "jobId"]) || !isContractString(value.jobId)
      : value.state !== "unavailable" || !hasOnly(value, ["state"]))
  ) {
    throw new InsightsContractError("invalid-page");
  }
};

const assertInstallationRow = (value: unknown): void => {
  if (
    !isRecord(value) ||
    !hasOnly(value, [
      "id",
      "install_id",
      "user_id",
      "username",
      "to_bundle_id",
      "type",
      "platform",
      "app_version",
      "channel",
      "cohort",
      "received_at_ms",
    ]) ||
    !isCanonicalInsightsEventId(value.id) ||
    typeof value.install_id !== "string" ||
    (value.user_id !== null && typeof value.user_id !== "string") ||
    (value.username !== null && typeof value.username !== "string") ||
    typeof value.to_bundle_id !== "string" ||
    !["UPDATE_APPLIED", "RECOVERED", "RELEASE_ADOPTED", "UNCHANGED"].includes(
      value.type as string,
    ) ||
    (value.platform !== "ios" && value.platform !== "android") ||
    typeof value.app_version !== "string" ||
    typeof value.channel !== "string" ||
    typeof value.cohort !== "string" ||
    !isSafeCount(value.received_at_ms)
  ) {
    throw new InsightsContractError("invalid-page");
  }
};

const assertReportRow = (section: string, value: unknown): void => {
  if (!isRecord(value)) throw new InsightsContractError("invalid-page");
  const metricRow = (): boolean =>
    hasOnly(value, ["bucketStartMs", "value"]) &&
    isSafeCount(value.bucketStartMs) &&
    isSafeCount(value.value);
  const valid =
    section === "movementSeries" || section === "activeSeries"
      ? metricRow()
      : section === "movementCohorts"
        ? hasOnly(value, ["cohort", "value"]) &&
          typeof value.cohort === "string" &&
          isSafeCount(value.value)
        : section === "bundleDistribution"
          ? hasOnly(value, ["bundleId", "installations"]) &&
            typeof value.bundleId === "string" &&
            isSafeCount(value.installations)
          : section === "activeBundleSeries" &&
            hasOnly(value, ["bundleId", "bucketStartMs", "value"]) &&
            typeof value.bundleId === "string" &&
            isSafeCount(value.bucketStartMs) &&
            isSafeCount(value.value);
  if (!valid) throw new InsightsContractError("invalid-page");
};

const assertReportPageOrder = (
  section: string,
  rows: readonly unknown[],
): void => {
  const completedBundles = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1] as ContractRecord;
    const row = rows[index] as ContractRecord;
    if (
      section === "activeBundleSeries" &&
      previous.bundleId !== row.bundleId
    ) {
      completedBundles.add(previous.bundleId as string);
      if (completedBundles.has(row.bundleId as string)) {
        throw new InsightsContractError("invalid-page");
      }
    }
    const invalid =
      section === "movementSeries" || section === "activeSeries"
        ? (previous.bucketStartMs as number) >= (row.bucketStartMs as number)
        : section === "movementCohorts"
          ? compareInsightsStrings(
              previous.cohort as string,
              row.cohort as string,
            ) >= 0
          : section === "bundleDistribution"
            ? (previous.installations as number) <
                (row.installations as number) ||
              ((previous.installations as number) ===
                (row.installations as number) &&
                compareInsightsStrings(
                  previous.bundleId as string,
                  row.bundleId as string,
                ) >= 0)
            : previous.bundleId === row.bundleId &&
              (previous.bucketStartMs as number) >=
                (row.bucketStartMs as number);
    if (invalid) throw new InsightsContractError("invalid-page");
  }
};

const assertPagePayload = (
  page: unknown,
  sourceGeneration: string,
  projectionGeneration: unknown,
  requestedLimit: number,
): void => {
  if (!isRecord(page) || !Array.isArray(page.data)) {
    throw new InsightsContractError("invalid-page");
  }
  const section = typeof page.section === "string" ? page.section : null;
  const fields = [
    "data",
    "nextCursor",
    "hasNext",
    "consistency",
    "total",
    ...(section === null ? [] : ["section"]),
    ...(section === "movementSeries" || section === "movementCohorts"
      ? ["metric"]
      : []),
  ];
  if (
    !hasOnly(page, fields) ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > INSIGHTS_PAGE_MAX_ROWS ||
    page.data.length > requestedLimit ||
    (page.nextCursor !== null && typeof page.nextCursor !== "string") ||
    typeof page.hasNext !== "boolean" ||
    page.hasNext !== (page.nextCursor !== null) ||
    !isRecord(page.consistency) ||
    !hasOnly(page.consistency, ["kind", "cutoff"]) ||
    !isRecord(page.consistency.cutoff)
  ) {
    throw new InsightsContractError("invalid-page");
  }
  const consistency = page.consistency as ContractRecord;
  const cutoff = consistency.cutoff as ContractRecord;
  let exactTotalRequired = false;
  let rowKind: "event" | "installation" | "report";
  if (
    consistency.kind === "live" &&
    cutoff.kind === "event-time" &&
    hasOnly(cutoff, ["kind", "beforeReceivedAtMs"]) &&
    isSafeCount(cutoff.beforeReceivedAtMs)
  ) {
    rowKind = "event";
  } else if (
    consistency.kind === "live" &&
    cutoff.kind === "projection" &&
    hasOnly(cutoff, ["kind", "observedAtMs", "projectionGeneration"]) &&
    isSafeCount(cutoff.observedAtMs) &&
    isContractString(cutoff.projectionGeneration) &&
    cutoff.projectionGeneration === projectionGeneration
  ) {
    rowKind = "installation";
  } else if (
    consistency.kind === "snapshot" &&
    cutoff.kind === "publication" &&
    hasOnly(cutoff, ["kind", "publication"])
  ) {
    assertPublication(cutoff.publication, sourceGeneration);
    exactTotalRequired = true;
    rowKind = section === null ? "installation" : "report";
  } else {
    throw new InsightsContractError("invalid-page");
  }
  if ((section === null) !== (rowKind !== "report")) {
    throw new InsightsContractError("invalid-page");
  }
  if (
    (rowKind === "event" && projectionGeneration !== null) ||
    (rowKind !== "event" && !isContractString(projectionGeneration))
  ) {
    throw new InsightsContractError("invalid-page");
  }
  assertTotal(page.total, sourceGeneration, exactTotalRequired);
  if (
    isRecord(page.total) &&
    page.total.state === "exact" &&
    isSafeCount(page.total.value) &&
    page.total.value < page.data.length
  ) {
    throw new InsightsContractError("invalid-page");
  }
  if (rowKind === "event") {
    const ids = new Set<string>();
    for (const [index, row] of page.data.entries()) {
      try {
        assertInsightsEventContract(row);
      } catch {
        throw new InsightsContractError("invalid-page");
      }
      if (
        row.received_at_ms >= (cutoff.beforeReceivedAtMs as number) ||
        ids.has(row.id)
      ) {
        throw new InsightsContractError("invalid-page");
      }
      ids.add(row.id);
      const previous = page.data[index - 1] as BundleEventRow | undefined;
      if (
        previous !== undefined &&
        (previous.received_at_ms < row.received_at_ms ||
          (previous.received_at_ms === row.received_at_ms &&
            previous.id <= row.id))
      ) {
        throw new InsightsContractError("invalid-page");
      }
    }
  } else if (rowKind === "installation") {
    page.data.forEach(assertInstallationRow);
  } else {
    if (
      ![
        "movementSeries",
        "movementCohorts",
        "bundleDistribution",
        "activeSeries",
        "activeBundleSeries",
      ].includes(section!) ||
      ((section === "movementSeries" || section === "movementCohorts") &&
        page.metric !== "installed" &&
        page.metric !== "recovered")
    ) {
      throw new InsightsContractError("invalid-page");
    }
    page.data.forEach((row) => assertReportRow(section!, row));
    assertReportPageOrder(section!, page.data);
  }
};

export type InsightsContractPageResult =
  | InsightsReadyRead<InsightsEventPageData, InsightsSourceReadVersions>
  | InsightsReadyRead<
      | InsightsLiveInstallationPageData
      | InsightsPublishedInstallationPageData
      | InsightsPublishedReportPageData,
      InsightsProjectedReadVersions
    >
  | InsightsStaleRead<
      InsightsPublishedInstallationPageData | InsightsPublishedReportPageData,
      InsightsProjectedReadVersions
    >;

/** Validates ready/stale bounded row pages, including state and generations. */
export function assertInsightsPageContract(
  value: unknown,
  requestedLimit: number,
): asserts value is InsightsContractPageResult {
  assertInsightsStringLimits(value, ["nextCursor"]);
  if (!isRecord(value)) throw new InsightsContractError("invalid-page");
  if (
    (value.state !== "ready" && value.state !== "stale") ||
    !hasOnly(value, [
      "state",
      "versions",
      "data",
      ...(value.state === "stale" ? ["refresh"] : []),
    ])
  ) {
    throw new InsightsContractError("invalid-page");
  }
  const versions = assertVersions(value.versions, "committed");
  if (value.state === "stale") assertJob(value.refresh);
  assertPagePayload(
    value.data,
    versions.sourceGeneration as string,
    versions.projectionGeneration,
    requestedLimit,
  );
  if (
    value.state === "stale" &&
    (!isRecord(value.data) ||
      !isRecord(value.data.consistency) ||
      value.data.consistency.kind !== "snapshot")
  ) {
    throw new InsightsContractError("invalid-page");
  }
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "page-too-large");
}

type InsightsExpiredRead = {
  readonly state: "expired";
  readonly publicationId: string;
};

export function assertInsightsPreparingReadContract(
  value: unknown,
): asserts value is InsightsPreparingRead {
  assertInsightsStringLimits(value, []);
  if (
    !isRecord(value) ||
    value.state !== "preparing" ||
    !hasOnly(value, ["state", "versions", "job"])
  ) {
    throw new InsightsContractError("invalid-response");
  }
  assertVersions(value.versions, "reserved");
  assertJob(value.job);
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "response-too-large");
}

export function assertInsightsFailedReadContract(
  value: unknown,
): asserts value is InsightsFailedRead {
  assertInsightsStringLimits(value, []);
  if (
    !isRecord(value) ||
    value.state !== "failed" ||
    !hasOnly(value, ["state", "versions", "error"])
  ) {
    throw new InsightsContractError("invalid-response");
  }
  assertVersions(value.versions, "failed");
  assertFailure(value.error);
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "response-too-large");
}

export function assertInsightsExpiredReadContract(
  value: unknown,
): asserts value is InsightsExpiredRead {
  assertInsightsStringLimits(value, []);
  if (
    !isRecord(value) ||
    value.state !== "expired" ||
    !hasOnly(value, ["state", "publicationId"]) ||
    !isContractString(value.publicationId)
  ) {
    throw new InsightsContractError("invalid-response");
  }
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "response-too-large");
}

export function assertInsightsReportResultContract(
  value: unknown,
): asserts value is InsightsReportResult {
  assertInsightsStringLimits(value, []);
  if (!isRecord(value)) throw new InsightsContractError("invalid-response");
  if (value.state === "preparing") {
    assertInsightsPreparingReadContract(value);
  } else if (value.state === "failed") {
    assertInsightsFailedReadContract(value);
  } else if (value.state === "ready" || value.state === "stale") {
    if (
      !hasOnly(value, [
        "state",
        "versions",
        "data",
        ...(value.state === "stale" ? ["refresh"] : []),
      ])
    ) {
      throw new InsightsContractError("invalid-response");
    }
    const versions = assertVersions(value.versions, "committed");
    if (!isContractString(versions.projectionGeneration)) {
      throw new InsightsContractError("invalid-response");
    }
    if (value.state === "stale") assertJob(value.refresh);
    assertPublication(value.data, versions.sourceGeneration as string, true);
  } else {
    throw new InsightsContractError("invalid-response");
  }
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "response-too-large");
}

export function assertInsightsReportPageResultContract(
  value: unknown,
  requestedLimit: number,
): asserts value is InsightsReportPage {
  assertInsightsStringLimits(value, ["nextCursor"]);
  if (!isRecord(value)) throw new InsightsContractError("invalid-response");
  if (value.state === "ready") {
    assertInsightsPageContract(value, requestedLimit);
  } else if (value.state === "failed") {
    assertInsightsFailedReadContract(value);
  } else if (value.state === "expired") {
    assertInsightsExpiredReadContract(value);
  } else {
    throw new InsightsContractError("invalid-response");
  }
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "response-too-large");
}

/** Validates non-page read states and ready/stale report publications. */
export const assertInsightsResponseContract = (value: unknown): void => {
  assertInsightsStringLimits(value, ["nextCursor"]);
  if (!isRecord(value) || !isContractString(value.state)) {
    throw new InsightsContractError("invalid-response");
  }
  if (value.state === "expired") assertInsightsExpiredReadContract(value);
  else if (value.state === "preparing")
    assertInsightsPreparingReadContract(value);
  else if (value.state === "failed") assertInsightsFailedReadContract(value);
  else assertInsightsReportResultContract(value);
  assertByteLimit(value, INSIGHTS_PAGE_MAX_BYTES, "response-too-large");
};

export const assertInsightsMaintenanceInputContract = (
  value: unknown,
): void => {
  assertInsightsStringLimits(value, ["cursor"]);
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(Reflect.get(value, "maxItems")) ||
    (Reflect.get(value, "maxItems") as number) < 1 ||
    (Reflect.get(value, "maxItems") as number) >
      INSIGHTS_MAINTENANCE_MAX_ITEMS ||
    !Number.isSafeInteger(Reflect.get(value, "maxRequests")) ||
    (Reflect.get(value, "maxRequests") as number) < 1 ||
    (Reflect.get(value, "maxRequests") as number) >
      INSIGHTS_MAINTENANCE_MAX_REQUESTS
  ) {
    throw new InsightsContractError("invalid-maintenance-input");
  }
  assertByteLimit(
    value,
    INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
    "maintenance-input-too-large",
  );
};

export interface InsightsInstallationIdentity {
  readonly digestHex: string;
  readonly installId: string;
}

/** Runtime-neutral SHA-256 key for native JavaScript installation identity. */
export const getInsightsInstallationOrderKey = async (
  installId: string,
): Promise<Uint8Array> => {
  assertInsightsStringLimits(installId, []);
  const bytes = new TextEncoder().encode(JSON.stringify(installId));
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes),
  );
};

export const compareInsightsInstallationOrderKeys = (
  left: Uint8Array,
  right: Uint8Array,
): number => {
  if (left.byteLength !== 32 || right.byteLength !== 32) {
    throw new InsightsContractError("installation-identity-collision");
  }
  for (let index = 0; index < 32; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
};

/** JavaScript UTF-16 code-unit order; never locale or database collation. */
export const compareInsightsStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const assertInsightsInstallationIdentityMatch = (
  expected: InsightsInstallationIdentity,
  actual: InsightsInstallationIdentity,
): void => {
  assertInsightsStringLimits(expected, []);
  assertInsightsStringLimits(actual, []);
  if (
    !/^[0-9a-f]{64}$/.test(expected.digestHex) ||
    !/^[0-9a-f]{64}$/.test(actual.digestHex) ||
    expected.digestHex !== actual.digestHex ||
    expected.installId !== actual.installId
  ) {
    throw new InsightsContractError("installation-identity-collision");
  }
};

/** Recomputes a stored digest from the retained complete installation ID. */
export const assertInsightsInstallationIdentityDigest = async (
  identity: InsightsInstallationIdentity,
): Promise<void> => {
  assertInsightsStringLimits(identity, []);
  const digestHex = Array.from(
    await getInsightsInstallationOrderKey(identity.installId),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  assertInsightsInstallationIdentityMatch(
    { digestHex, installId: identity.installId },
    identity,
  );
};

/**
 * Providers hash the UTF-8 bytes of `json` and compare the raw 32 digest bytes.
 * Hex is present only to make cross-provider conformance tests readable.
 */
export const INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS = [
  {
    installId: "",
    json: '""',
    sha256Hex:
      "12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126",
  },
  {
    installId: "install-001",
    json: '"install-001"',
    sha256Hex:
      "3ece873eda980b7261904ff95d66434a53ac088a04f1d2c9b7fe266527af908b",
  },
  {
    installId: "설치-😀",
    json: '"설치-😀"',
    sha256Hex:
      "a8e2dfbe8e8386d34d6ae4c3823b0b30440a33e346095681a170c6479e891194",
  },
  {
    installId: 'quote"and\\slash',
    json: '"quote\\"and\\\\slash"',
    sha256Hex:
      "711e2e8a34d007e7612de268240b6ff21e009142b9f4d81ed5045a5f68875bbb",
  },
  {
    installId: "\n\t\u0001",
    json: '"\\n\\t\\u0001"',
    sha256Hex:
      "9694895afedc2dcc61a527268ffd36ec0c85a33414237dfec8446262ee1e9325",
  },
  {
    installId: "line\u2028separator",
    json: '"line\u2028separator"',
    sha256Hex:
      "e9676559065f972d38120ddcb077261ee9c1ca03a61a7307cf93620c2b4ef3e3",
  },
  {
    installId: "é",
    json: '"é"',
    sha256Hex:
      "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086",
  },
  {
    installId: "e\u0301",
    json: '"e\u0301"',
    sha256Hex:
      "3d68ce21f2899a475713cdbe7562ba9bdb6b1dfde8af1f221bdff4a0935b53b2",
  },
  {
    installId: "supplementary-𐐀",
    json: '"supplementary-𐐀"',
    sha256Hex:
      "54ee779e7ce492c402e4edb30bba066294e089062417bb0562ee7f0d10af2c39",
  },
] as const;
