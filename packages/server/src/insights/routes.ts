import {
  DatabasePluginInputError,
  type InsightsActiveWindow,
  type InsightsInstallationPageInput,
  type InsightsModel,
  type InsightsPageEventsInput,
  type InsightsPageEventsSelector,
  type InsightsReportInput,
  type InsightsReportPageInput,
  type InsightsReportQuery,
  type InsightsReportWindow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsQueryContract,
  assertWellFormedInsightsString,
  InsightsContractError,
  INSIGHTS_DEFAULT_PAGE_ROWS,
  INSIGHTS_PAGE_MAX_ROWS,
  INSIGHTS_STRING_MAX_CODE_UNITS,
} from "@hot-updater/plugin-core/internal";

import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import type { RouteHandler } from "../handlerTypes";
import {
  InsightsBadRequestError,
  InsightsPayloadTooLargeError,
} from "./errors";
import { createBundleEventRow, parseBundleEventRequest } from "./eventInput";
import {
  assertInsightsOperationResult,
  type InsightsOperation,
} from "./provider";

type Params = URLSearchParams;

const invalid = (): never => {
  throw new InsightsBadRequestError("Invalid Insights query.");
};

const readParams = (request: Request): Params => {
  const query = request.url.match(/\?([^#]*)/)?.[1] ?? "";
  for (const component of query.split(/[&=]/)) {
    try {
      decodeURIComponent(component.replace(/\+/g, "%20"));
    } catch {
      invalid();
    }
  }
  return new URL(request.url).searchParams;
};

const assertFields = (params: Params, allowed: readonly string[]): void => {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  }
};

const readInteger = (
  params: Params,
  key: string,
  fallback?: number,
): number | undefined => {
  const value = params.get(key);
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid();
  return number;
};

const readString = (
  params: Params,
  key: string,
  options: { readonly allowEmpty?: boolean } = {},
): string | undefined => {
  const value = params.get(key);
  if (value === null) return undefined;
  if (
    (!options.allowEmpty && value.length === 0) ||
    value.length > INSIGHTS_STRING_MAX_CODE_UNITS
  ) {
    invalid();
  }
  try {
    assertWellFormedInsightsString(value);
  } catch {
    invalid();
  }
  return value;
};

const readPage = (
  params: Params,
): { readonly limit: number; readonly cursor?: string } => {
  const limit = readInteger(params, "limit", INSIGHTS_DEFAULT_PAGE_ROWS)!;
  if (limit < 1 || limit > INSIGHTS_PAGE_MAX_ROWS) invalid();
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined) {
    if (cursor.length === 0) invalid();
    try {
      assertInsightsCursorContract(cursor);
    } catch {
      invalid();
    }
  }
  return cursor === undefined ? { limit } : { limit, cursor };
};

const checked = <T>(input: T): T => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    invalid();
  }
  return input;
};

const parseEventPageInput = (
  request: Request,
  fixedSelector?: InsightsPageEventsSelector,
): InsightsPageEventsInput => {
  const params = readParams(request);
  assertFields(params, [
    ...(fixedSelector === undefined ? ["installId"] : []),
    "sinceReceivedAtMs",
    "beforeReceivedAtMs",
    "limit",
    "cursor",
  ]);
  const installId = readString(params, "installId", { allowEmpty: true });
  const selector =
    fixedSelector ??
    (params.has("installId")
      ? { kind: "installationId" as const, installId: installId! }
      : { kind: "all" as const });
  const page = readPage(params);
  if (page.cursor !== undefined && !params.has("beforeReceivedAtMs")) invalid();
  const beforeReceivedAtMs = readInteger(
    params,
    "beforeReceivedAtMs",
    Date.now(),
  )!;
  const sinceReceivedAtMs = readInteger(params, "sinceReceivedAtMs");
  if (
    sinceReceivedAtMs !== undefined &&
    sinceReceivedAtMs > beforeReceivedAtMs
  ) {
    invalid();
  }
  return checked({
    selector,
    beforeReceivedAtMs,
    ...page,
    ...(sinceReceivedAtMs === undefined ? {} : { sinceReceivedAtMs }),
  });
};

const parseInstallationPageInput = (
  request: Request,
): InsightsInstallationPageInput => {
  const params = readParams(request);
  assertFields(params, [
    "kind",
    "installId",
    "userId",
    "query",
    "publicationId",
    "minAsOfMs",
    "limit",
    "cursor",
  ]);
  const page = readPage(params);
  const kind = params.get("kind");
  const query = readString(params, "query", { allowEmpty: true });
  const installId = readString(params, "installId", { allowEmpty: true });
  const userId = readString(params, "userId");
  const publicationId = readString(params, "publicationId");
  const minAsOfMs = readInteger(params, "minAsOfMs");
  const only = (...keys: string[]) =>
    [...params.keys()].every(
      (key) => keys.includes(key) || key === "limit" || key === "cursor",
    );

  if (kind === "all" && query === undefined) {
    if (!only("kind")) invalid();
    return checked({ kind: "all", ...page });
  }
  if (kind === "installationId" && installId !== undefined) {
    if (!only("kind", "installId") || page.cursor !== undefined) invalid();
    return checked({ kind, installId, limit: page.limit });
  }
  if (kind === "userId" && userId !== undefined) {
    if (!only("kind", "userId", "publicationId", "minAsOfMs")) invalid();
    return checked({
      kind,
      userId,
      ...page,
      ...(publicationId === undefined ? {} : { publicationId }),
      ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
    });
  }
  if (kind === "contains" && query !== undefined) {
    if (
      query.length === 0 ||
      !only("kind", "query", "publicationId", "minAsOfMs")
    ) {
      invalid();
    }
    return checked({
      kind: "contains",
      query,
      ...page,
      ...(publicationId === undefined ? {} : { publicationId }),
      ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
    });
  }
  return invalid();
};

const readWindow = (
  params: Params,
  fallback: InsightsReportWindow,
): InsightsReportWindow => {
  const value = params.get("window") ?? fallback;
  if (value !== "24h" && value !== "7d" && value !== "30d" && value !== "all") {
    invalid();
  }
  return value as InsightsReportWindow;
};

const parseReportInput = (
  request: Request,
  route:
    | { readonly query: InsightsReportQuery }
    | {
        readonly kind: "bundleDetail";
        readonly bundleId: string;
        readonly defaultWindow: InsightsReportWindow;
      }
    | {
        readonly kind: "activeOverview";
        readonly defaultWindow: InsightsActiveWindow;
      },
): InsightsReportInput => {
  const params = readParams(request);
  const fixed = "query" in route;
  const active = !fixed && route.kind === "activeOverview";
  const windowed = !fixed;
  assertFields(params, [
    ...(windowed ? ["window"] : []),
    ...(active ? ["userId"] : []),
    "minAsOfMs",
  ]);
  const minAsOfMs = readInteger(params, "minAsOfMs");
  let reportQuery: InsightsReportQuery;
  if (fixed) {
    reportQuery = route.query;
  } else if (route.kind === "bundleDetail") {
    reportQuery = {
      kind: route.kind,
      bundleId: route.bundleId,
      window: readWindow(params, route.defaultWindow),
    };
  } else {
    const window = readWindow(params, route.defaultWindow);
    if (window === "all") invalid();
    const userId = readString(params, "userId");
    reportQuery = {
      kind: route.kind,
      window: window as InsightsActiveWindow,
      ...(userId === undefined ? {} : { userId }),
    };
  }
  return checked({
    query: reportQuery,
    ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
  });
};

const parseReportPageInput = (
  request: Request,
  publicationId: string,
): InsightsReportPageInput => {
  const params = readParams(request);
  assertFields(params, ["section", "metric", "bundleId", "limit", "cursor"]);
  const page = readPage(params);
  const section = params.get("section");
  const metric = params.get("metric");
  const bundleId = readString(params, "bundleId");
  let input: InsightsReportPageInput;
  if (section === "movementSeries" || section === "movementCohorts") {
    if (
      (metric !== "installed" && metric !== "recovered") ||
      bundleId !== undefined
    ) {
      invalid();
    }
    input = {
      publicationId,
      section,
      metric: metric as "installed" | "recovered",
      ...page,
    };
  } else if (section === "bundleDistribution" || section === "activeSeries") {
    if (metric !== null || bundleId !== undefined) invalid();
    input = { publicationId, section, ...page };
  } else if (section === "activeBundleSeries") {
    if (metric !== null) invalid();
    input = {
      publicationId,
      section,
      ...page,
      ...(bundleId === undefined ? {} : { bundleId }),
    };
  } else {
    return invalid();
  }
  return checked(input);
};

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    headers: { "cache-control": "private, no-store" },
    status,
  });

const requireParam = (
  params: Readonly<Record<string, string>>,
  key: string,
): string => {
  const encoded = params[key];
  let value: string;
  try {
    value = decodeURIComponent(encoded ?? "");
  } catch {
    throw new InsightsBadRequestError(
      `Missing or invalid route parameter: ${key}`,
    );
  }
  if (
    encoded === undefined ||
    value.length === 0 ||
    value.length > INSIGHTS_STRING_MAX_CODE_UNITS
  ) {
    throw new InsightsBadRequestError(
      `Missing or invalid route parameter: ${key}`,
    );
  }
  try {
    assertWellFormedInsightsString(value);
  } catch {
    throw new InsightsBadRequestError(
      `Missing or invalid route parameter: ${key}`,
    );
  }
  return value;
};

const run = async (
  operation: () => Promise<Response>,
  context: "append" | "read" = "read",
): Promise<Response> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof InsightsBadRequestError ||
      (error instanceof DatabasePluginInputError &&
        error.code === "invalid-query")
    ) {
      return json({ error: { code: "INSIGHTS_INVALID_QUERY" } }, 400);
    }
    if (
      error instanceof InsightsPayloadTooLargeError ||
      (error instanceof InsightsContractError &&
        context === "append" &&
        error.reason === "event-too-large")
    ) {
      return json({ error: { code: "INSIGHTS_PAYLOAD_TOO_LARGE" } }, 413);
    }
    if (error instanceof HotUpdaterSchemaMigrationRequiredError) {
      return json(
        { error: { code: "INSIGHTS_SCHEMA_MIGRATION_REQUIRED" } },
        503,
      );
    }
    return json({ error: { code: "INSIGHTS_QUERY_FAILED" } }, 500);
  }
};

const query = (
  operation: () => Promise<{
    readonly body: unknown;
    readonly expected: InsightsOperation;
  }>,
): Promise<Response> =>
  run(async () => {
    const { body, expected } = await operation();
    assertInsightsOperationResult(body, expected);
    return json(body, 200);
  });

type PageInput = { readonly limit: number };

const maintenanceJobId = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  if (Reflect.get(value, "state") === "preparing") {
    const job = Reflect.get(value, "job");
    return typeof job === "object" &&
      job !== null &&
      typeof Reflect.get(job, "id") === "string"
      ? (Reflect.get(job, "id") as string)
      : null;
  }
  if (Reflect.get(value, "state") === "stale") {
    const refresh = Reflect.get(value, "refresh");
    return typeof refresh === "object" &&
      refresh !== null &&
      typeof Reflect.get(refresh, "id") === "string"
      ? (Reflect.get(refresh, "id") as string)
      : null;
  }
  return null;
};

const readWithMaintenance = async (
  provider: InsightsModel,
  operation: () => Promise<unknown>,
  expected: InsightsOperation,
): Promise<unknown> => {
  const initial = await operation();
  assertInsightsOperationResult(initial, expected);
  const jobId = maintenanceJobId(initial);
  if (jobId === null) return initial;
  await provider.runMaintenanceStep({
    jobId,
    maxItems: 256,
    maxRequests: 512,
  });
  if (
    typeof initial === "object" &&
    initial !== null &&
    Reflect.get(initial, "state") === "stale"
  ) {
    return initial;
  }
  return operation();
};

const pageQuery = <TInput extends PageInput>(
  provider: InsightsModel,
  readInput: () => TInput,
  operation: (input: TInput) => Promise<unknown>,
  expected: (input: TInput) => InsightsOperation,
): Promise<Response> =>
  query(async () => {
    const input = readInput();
    const operationExpected = expected(input);
    return {
      body: await readWithMaintenance(
        provider,
        () => operation(input),
        operationExpected,
      ),
      expected: operationExpected,
    };
  });

const reportQuery = (
  provider: InsightsModel,
  readInput: () => Parameters<InsightsModel["getReport"]>[0],
  operation: InsightsModel["getReport"],
): Promise<Response> =>
  query(async () => {
    const input = readInput();
    const expected = { kind: "report" as const, input };
    return {
      body: await readWithMaintenance(
        provider,
        () => operation(input),
        expected,
      ),
      expected,
    };
  });

export const createInsightsRouteHandlers = (
  provider: InsightsModel,
): Record<string, RouteHandler> => ({
  appendBundleEvent: async (_params, request) =>
    run(async () => {
      const input = await parseBundleEventRequest(request);
      await provider.append(createBundleEventRow(input));
      return new Response(null, { status: 204 });
    }, "append"),
  getEventHistory: (_params, request) =>
    pageQuery(
      provider,
      () => parseEventPageInput(request),
      (input) => provider.pageEvents(input),
      (input) => ({ kind: "events", input }),
    ),
  getBundleEventHistory: (params, request) =>
    pageQuery(
      provider,
      () =>
        parseEventPageInput(request, {
          kind: "bundleId",
          bundleId: requireParam(params, "id"),
        }),
      (input) => provider.pageEvents(input),
      (input) => ({ kind: "events", input }),
    ),
  getBundleEventSummary: (params, request) =>
    reportQuery(
      provider,
      () =>
        parseReportInput(request, {
          query: {
            kind: "bundleSummaries",
            bundleIds: [requireParam(params, "id")],
            window: "all",
          },
        }),
      (input) => provider.getReport(input),
    ),
  getBundleEventInsights: (params, request) =>
    reportQuery(
      provider,
      () =>
        parseReportInput(request, {
          kind: "bundleDetail",
          bundleId: requireParam(params, "id"),
          defaultWindow: "24h",
        }),
      (input) => provider.getReport(input),
    ),
  getBundleEventOverview: (_params, request) =>
    reportQuery(
      provider,
      () =>
        parseReportInput(request, {
          query: { kind: "installationOverview" },
        }),
      (input) => provider.getReport(input),
    ),
  getActiveInstallationOverview: (_params, request) =>
    reportQuery(
      provider,
      () =>
        parseReportInput(request, {
          kind: "activeOverview",
          defaultWindow: "30d",
        }),
      (input) => provider.getReport(input),
    ),
  searchInstallations: (_params, request) =>
    pageQuery(
      provider,
      () => parseInstallationPageInput(request),
      (input) => provider.pageInstallations(input),
      (input) => ({ kind: "installations", input }),
    ),
  getInsightsReportPage: (params, request) =>
    pageQuery(
      provider,
      () =>
        parseReportPageInput(request, requireParam(params, "publicationId")),
      (input) => provider.pageReport(input),
      (input) => ({ kind: "report-page", input }),
    ),
});

export const registerInsightsClientRoutes = (
  add: (method: string, path: string, handler: string) => void,
): void => {
  add("POST", "/events", "appendBundleEvent");
};

export const registerInsightsAdminRoutes = (
  add: (method: string, path: string, handler: string) => void,
): void => {
  add("GET", "/events", "getEventHistory");
  add("GET", "/bundles/:id/events", "getBundleEventHistory");
  add("GET", "/bundles/:id/events/summary", "getBundleEventSummary");
  add("GET", "/bundles/:id/events/insights", "getBundleEventInsights");
  add("GET", "/installations/overview", "getBundleEventOverview");
  add("GET", "/installations/active", "getActiveInstallationOverview");
  add("GET", "/installations", "searchInstallations");
  add("GET", "/insights/reports/:publicationId", "getInsightsReportPage");
};
