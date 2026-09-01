import type {
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
  InsightsReportInput,
  InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsExpiredReadContract,
  assertInsightsFailedReadContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  assertInsightsQueryContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  assertWellFormedInsightsString,
  InsightsContractError,
  INSIGHTS_PAGE_MAX_ROWS,
  INSIGHTS_STRING_MAX_CODE_UNITS,
  readInsightsReportPageInput,
  readInsightsReportQuery,
  type RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";

export type RequiredInsightsResultKind =
  | "live-page"
  | "published-page"
  | "report"
  | "report-page";

export type RequiredInsightsOperation =
  | { readonly kind: "events"; readonly input: InsightsPageEventsInput }
  | {
      readonly kind: "installations";
      readonly input: InsightsInstallationPageInput;
    }
  | { readonly kind: "report"; readonly input: InsightsReportInput }
  | { readonly kind: "report-page"; readonly input: InsightsReportPageInput };

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return invalid();
  return value;
};

const hasOnly = (
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean => Object.keys(value).every((field) => fields.includes(field));

const identifier = (value: unknown, allowEmpty = false): value is string => {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > INSIGHTS_STRING_MAX_CODE_UNITS
  ) {
    return false;
  }
  try {
    assertWellFormedInsightsString(value);
    return true;
  } catch {
    return false;
  }
};

const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const assertRequiredInsightsResult = (
  value: unknown,
  kind: RequiredInsightsResultKind,
  requestedLimit?: number,
): void => {
  if (kind === "report") {
    assertInsightsReportResultContract(value);
    return;
  }
  if (kind === "report-page") {
    if (requestedLimit === undefined) {
      throw new InsightsContractError("invalid-page");
    }
    assertInsightsReportPageResultContract(value, requestedLimit);
    return;
  }
  if (!isRecord(value)) {
    throw new InsightsContractError("invalid-response");
  }
  if (
    value.state === "ready" ||
    (value.state === "stale" && kind === "published-page")
  ) {
    if (requestedLimit === undefined) {
      throw new InsightsContractError("invalid-page");
    }
    assertInsightsPageContract(value, requestedLimit);
    return;
  }
  if (value.state === "preparing") {
    assertInsightsPreparingReadContract(value);
  } else if (value.state === "failed") {
    assertInsightsFailedReadContract(value);
  } else if (value.state === "expired" && kind === "published-page") {
    assertInsightsExpiredReadContract(value);
  } else {
    throw new InsightsContractError("invalid-response");
  }
};

const resultData = (value: unknown): Readonly<Record<string, unknown>> | null =>
  isRecord(value) &&
  (value.state === "ready" || value.state === "stale") &&
  isRecord(value.data)
    ? value.data
    : null;

const pagePublication = (
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null => {
  const consistency = data.consistency;
  if (!isRecord(consistency)) return null;
  const cutoff = consistency.cutoff;
  if (!isRecord(cutoff)) return null;
  const publication = cutoff.publication;
  return isRecord(publication) ? publication : null;
};

const assertResultCorrelation = (
  value: unknown,
  operation: RequiredInsightsOperation,
): void => {
  const result = isRecord(value) ? value : null;
  const data = resultData(value);
  if (data !== null) {
    const versions = isRecord(result?.versions) ? result.versions : null;
    const projectionGeneration = versions?.projectionGeneration;
    if (
      (operation.kind === "events" && projectionGeneration !== null) ||
      (operation.kind !== "events" && typeof projectionGeneration !== "string")
    ) {
      throw new InsightsContractError("invalid-response");
    }
  }
  if (operation.kind === "events") {
    if (data === null) return;
    const consistency = data.consistency;
    const cutoff = isRecord(consistency) ? consistency.cutoff : null;
    if (
      !isRecord(cutoff) ||
      cutoff.beforeReceivedAtMs !== operation.input.beforeReceivedAtMs
    ) {
      throw new InsightsContractError("invalid-page");
    }
    const rows = data.data;
    if (!Array.isArray(rows)) {
      throw new InsightsContractError("invalid-page");
    }
    for (const row of rows) {
      if (
        !isRecord(row) ||
        typeof row.received_at_ms !== "number" ||
        row.received_at_ms >= operation.input.beforeReceivedAtMs ||
        (operation.input.sinceReceivedAtMs !== undefined &&
          row.received_at_ms < operation.input.sinceReceivedAtMs)
      ) {
        throw new InsightsContractError("invalid-page");
      }
      const selector = operation.input.selector;
      if (
        selector.kind === "installationId" &&
        (row.install_id !== selector.installId ||
          (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED"))
      ) {
        throw new InsightsContractError("invalid-page");
      }
      if (
        selector.kind === "bundleId" &&
        !(
          (row.type === "UPDATE_APPLIED" &&
            row.to_bundle_id === selector.bundleId) ||
          (row.type === "RECOVERED" && row.from_bundle_id === selector.bundleId)
        )
      ) {
        throw new InsightsContractError("invalid-page");
      }
    }
    return;
  }
  if (operation.kind === "installations") {
    if (
      operation.input.kind === "all" ||
      operation.input.kind === "installationId"
    ) {
      if (operation.input.kind === "installationId" && data !== null) {
        const installId = operation.input.installId;
        const rows = data.data;
        if (
          !Array.isArray(rows) ||
          rows.length > 1 ||
          data.nextCursor !== null ||
          data.hasNext !== false ||
          rows.some((row) => !isRecord(row) || row.install_id !== installId)
        ) {
          throw new InsightsContractError("invalid-page");
        }
      }
      return;
    }
    const expectedPublicationId = operation.input.publicationId;
    if (
      (result?.state === "preparing" && operation.input.cursor !== undefined) ||
      (expectedPublicationId !== undefined &&
        operation.input.cursor === undefined &&
        (result?.state === "preparing" || result?.state === "stale"))
    ) {
      throw new InsightsContractError("invalid-response");
    }
    if (result?.state === "expired") {
      if (
        (expectedPublicationId === undefined &&
          operation.input.cursor === undefined) ||
        (expectedPublicationId !== undefined &&
          result.publicationId !== expectedPublicationId)
      ) {
        throw new InsightsContractError("invalid-response");
      }
    } else if (data !== null) {
      const publication = pagePublication(data);
      if (
        (expectedPublicationId !== undefined &&
          publication?.id !== expectedPublicationId) ||
        (result?.state === "ready" &&
          operation.input.minAsOfMs !== undefined &&
          (typeof publication?.asOfMs !== "number" ||
            publication.asOfMs < operation.input.minAsOfMs))
      ) {
        throw new InsightsContractError("invalid-page");
      }
    }
    return;
  }
  if (operation.kind === "report") {
    if (data === null) return;
    const expected = readInsightsReportQuery(operation.input).query;
    if (data.kind !== expected.kind) {
      throw new InsightsContractError("invalid-response");
    }
    if (
      result?.state === "ready" &&
      operation.input.minAsOfMs !== undefined &&
      (typeof data.asOfMs !== "number" ||
        data.asOfMs < operation.input.minAsOfMs)
    ) {
      throw new InsightsContractError("invalid-response");
    }
    if (expected.kind === "bundleSummaries") {
      const summary = data.summary;
      const actualIds = Array.isArray(summary)
        ? summary.map((row) => (isRecord(row) ? row.bundleId : undefined))
        : [];
      if (
        actualIds.length !== expected.bundleIds.length ||
        actualIds.some((id, index) => id !== expected.bundleIds[index])
      ) {
        throw new InsightsContractError("invalid-response");
      }
    }
    return;
  }
  if (result?.state === "expired") {
    if (result.publicationId !== operation.input.publicationId) {
      throw new InsightsContractError("invalid-response");
    }
    return;
  }
  if (data === null) return;
  if (
    data.section !== operation.input.section ||
    ((operation.input.section === "movementSeries" ||
      operation.input.section === "movementCohorts") &&
      data.metric !== operation.input.metric) ||
    pagePublication(data)?.id !== operation.input.publicationId
  ) {
    throw new InsightsContractError("invalid-page");
  }
  if (operation.input.section === "activeBundleSeries") {
    const bundleId = operation.input.bundleId;
    if (
      bundleId !== undefined &&
      (!Array.isArray(data.data) ||
        data.data.some((row) => !isRecord(row) || row.bundleId !== bundleId))
    ) {
      throw new InsightsContractError("invalid-page");
    }
  }
};

export const assertRequiredInsightsOperationResult = (
  value: unknown,
  operation: RequiredInsightsOperation,
): void => {
  const resultKind: RequiredInsightsResultKind =
    operation.kind === "events"
      ? "live-page"
      : operation.kind === "installations"
        ? operation.input.kind === "all" ||
          operation.input.kind === "installationId"
          ? "live-page"
          : "published-page"
        : operation.kind;
  const requestedLimit =
    operation.kind === "report" ? undefined : operation.input.limit;
  assertRequiredInsightsResult(value, resultKind, requestedLimit);
  const data = resultData(value);
  if (
    operation.kind !== "report" &&
    data !== null &&
    (data.nextCursor === "" ||
      (operation.input.cursor !== undefined &&
        data.nextCursor === operation.input.cursor))
  ) {
    throw new InsightsContractError("invalid-page");
  }
  if (
    operation.kind !== "report" &&
    operation.input.cursor === undefined &&
    data?.nextCursor === null &&
    isRecord(data.total) &&
    data.total.state === "exact" &&
    Array.isArray(data.data) &&
    data.total.value !== data.data.length
  ) {
    throw new InsightsContractError("invalid-page");
  }
  assertResultCorrelation(value, operation);
};

const page = (
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> => {
  const value = record(input);
  if (!hasOnly(value, [...fields, "limit", "cursor"])) {
    invalid();
  }
  if (
    typeof value.limit !== "number" ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > INSIGHTS_PAGE_MAX_ROWS
  ) {
    invalid();
  }
  return value;
};

const assertEventPageInput = (input: unknown): void => {
  const value = page(input, [
    "selector",
    "sinceReceivedAtMs",
    "beforeReceivedAtMs",
  ]);
  if (
    !timestamp(value.beforeReceivedAtMs) ||
    (value.sinceReceivedAtMs !== undefined &&
      !timestamp(value.sinceReceivedAtMs)) ||
    (typeof value.sinceReceivedAtMs === "number" &&
      value.sinceReceivedAtMs > value.beforeReceivedAtMs)
  ) {
    invalid();
  }
  const selector = record(value.selector);
  if (selector.kind === "all") {
    if (!hasOnly(selector, ["kind"])) invalid();
  } else if (selector.kind === "installationId") {
    if (
      !hasOnly(selector, ["kind", "installId"]) ||
      !identifier(selector.installId, true)
    ) {
      invalid();
    }
  } else if (selector.kind === "bundleId") {
    if (
      !hasOnly(selector, ["kind", "bundleId"]) ||
      !identifier(selector.bundleId)
    ) {
      invalid();
    }
  } else {
    invalid();
  }
};

const assertInstallationPageInput = (input: unknown): void => {
  const value = page(input, [
    "kind",
    "installId",
    "userId",
    "query",
    "publicationId",
    "minAsOfMs",
  ]);
  const freshnessIsValid =
    (value.publicationId === undefined || identifier(value.publicationId)) &&
    (value.minAsOfMs === undefined || timestamp(value.minAsOfMs));
  if (value.kind === "all") {
    if (!hasOnly(value, ["kind", "limit", "cursor"])) invalid();
  } else if (value.kind === "installationId") {
    if (
      !hasOnly(value, ["kind", "installId", "limit", "cursor"]) ||
      !identifier(value.installId, true) ||
      value.cursor !== undefined
    ) {
      invalid();
    }
  } else if (value.kind === "userId") {
    if (!identifier(value.userId) || !freshnessIsValid) invalid();
    if (
      !hasOnly(value, [
        "kind",
        "userId",
        "publicationId",
        "minAsOfMs",
        "limit",
        "cursor",
      ])
    ) {
      invalid();
    }
  } else if (value.kind === "contains") {
    if (!identifier(value.query) || !freshnessIsValid) invalid();
    if (
      !hasOnly(value, [
        "kind",
        "query",
        "publicationId",
        "minAsOfMs",
        "limit",
        "cursor",
      ])
    ) {
      invalid();
    }
  } else {
    invalid();
  }
};

const read = async <TResult>(
  input: unknown,
  beforeOperation: () => Promise<void>,
  operation: () => Promise<TResult>,
  expected: RequiredInsightsOperation,
): Promise<TResult> => {
  assertInsightsQueryContract(input);
  await beforeOperation();
  const result = await operation();
  assertRequiredInsightsOperationResult(result, expected);
  return result;
};

export const createRequiredInsightsProvider = (
  model: RequiredInsightsModel,
  beforeOperation: () => Promise<void>,
): RequiredInsightsModel => {
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
    assertInstallationPageInput(input);
    return read(input, beforeOperation, () => model.pageInstallations(input), {
      kind: "installations",
      input,
    });
  }

  return {
    async append(row) {
      assertInsightsEventContract(row);
      await beforeOperation();
      return model.append(row);
    },
    async pageEvents(input) {
      assertEventPageInput(input);
      return read(input, beforeOperation, () => model.pageEvents(input), {
        kind: "events",
        input,
      });
    },
    pageInstallations,
    async getReport(input) {
      const { query, minAsOfMs } = readInsightsReportQuery(input);
      const canonicalInput = {
        query,
        ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
      };
      return read(
        canonicalInput,
        beforeOperation,
        () => model.getReport(canonicalInput),
        { kind: "report", input: canonicalInput },
      );
    },
    async pageReport(input) {
      const canonicalInput = readInsightsReportPageInput(input);
      return read(
        canonicalInput,
        beforeOperation,
        () => model.pageReport(canonicalInput),
        {
          kind: "report-page",
          input: canonicalInput,
        },
      );
    },
  };
};
