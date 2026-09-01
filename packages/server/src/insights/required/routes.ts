import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import {
  assertWellFormedInsightsString,
  InsightsContractError,
  INSIGHTS_STRING_MAX_CODE_UNITS,
} from "@hot-updater/plugin-core/internal";
import type { RequiredInsightsModel } from "@hot-updater/plugin-core/internal";

import { HotUpdaterSchemaMigrationRequiredError } from "../../db/schemaReadiness";
import type { RouteHandler } from "../../handlerTypes";
import {
  InsightsBadRequestError,
  InsightsPayloadTooLargeError,
} from "../errors";
import { createBundleEventRow, parseBundleEventRequest } from "../eventInput";
import {
  assertRequiredInsightsOperationResult,
  type RequiredInsightsOperation,
} from "./provider";
import {
  parseEventPageInput,
  parseInstallationPageInput,
  parseReportInput,
  parseReportPageInput,
} from "./queryInput";

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
    readonly expected: RequiredInsightsOperation;
  }>,
): Promise<Response> =>
  run(async () => {
    const { body, expected } = await operation();
    assertRequiredInsightsOperationResult(body, expected);
    return json(body, 200);
  });

type PageInput = { readonly limit: number };

const pageQuery = <TInput extends PageInput>(
  readInput: () => TInput,
  operation: (input: TInput) => Promise<unknown>,
  expected: (input: TInput) => RequiredInsightsOperation,
): Promise<Response> =>
  query(async () => {
    const input = readInput();
    return {
      body: await operation(input),
      expected: expected(input),
    };
  });

const reportQuery = (
  readInput: () => Parameters<RequiredInsightsModel["getReport"]>[0],
  operation: RequiredInsightsModel["getReport"],
): Promise<Response> =>
  query(async () => {
    const input = readInput();
    return {
      body: await operation(input),
      expected: { kind: "report", input },
    };
  });

export const createRequiredInsightsRouteHandlers = (
  provider: RequiredInsightsModel,
): Record<string, RouteHandler> => ({
  appendBundleEvent: async (_params, request) =>
    run(async () => {
      const input = await parseBundleEventRequest(request);
      await provider.append(createBundleEventRow(input));
      return new Response(null, { status: 204 });
    }, "append"),
  getEventHistory: (_params, request) =>
    pageQuery(
      () => parseEventPageInput(request),
      (input) => provider.pageEvents(input),
      (input) => ({ kind: "events", input }),
    ),
  getBundleEventHistory: (params, request) =>
    pageQuery(
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
      () =>
        parseReportInput(request, {
          query: { kind: "installationOverview" },
        }),
      (input) => provider.getReport(input),
    ),
  getActiveInstallationOverview: (_params, request) =>
    reportQuery(
      () =>
        parseReportInput(request, {
          kind: "activeOverview",
          defaultWindow: "30d",
        }),
      (input) => provider.getReport(input),
    ),
  searchInstallations: (_params, request) =>
    pageQuery(
      () => parseInstallationPageInput(request),
      (input) => provider.pageInstallations(input),
      (input) => ({ kind: "installations", input }),
    ),
  getInsightsReportPage: (params, request) =>
    pageQuery(
      () =>
        parseReportPageInput(request, requireParam(params, "publicationId")),
      (input) => provider.pageReport(input),
      (input) => ({ kind: "report-page", input }),
    ),
});

export const registerRequiredInsightsClientRoutes = (
  add: (method: string, path: string, handler: string) => void,
): void => {
  add("POST", "/events", "appendBundleEvent");
};

export const registerRequiredInsightsAdminRoutes = (
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
