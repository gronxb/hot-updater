import type {
  InsightsActiveWindow,
  InsightsInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPageEventsSelector,
  InsightsReportInput,
  InsightsReportPageInput,
  InsightsReportQuery,
  InsightsReportWindow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsQueryContract,
  assertWellFormedInsightsString,
  INSIGHTS_DEFAULT_PAGE_ROWS,
  INSIGHTS_PAGE_MAX_ROWS,
  INSIGHTS_STRING_MAX_CODE_UNITS,
} from "@hot-updater/plugin-core/internal";

import { InsightsBadRequestError } from "../errors";

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

export const parseEventPageInput = (
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

export const parseInstallationPageInput = (
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

export const parseReportInput = (
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

export const parseReportPageInput = (
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
