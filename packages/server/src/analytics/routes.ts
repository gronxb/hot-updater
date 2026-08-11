import type { RouteHandler } from "../handlerTypes";
import {
  AnalyticsBadRequestError,
  AnalyticsPayloadTooLargeError,
  AnalyticsScanLimitExceededError,
} from "./errors";
import { parseBundleEventRequest } from "./eventInput";
import {
  parseActiveInstallationInput,
  parseAnalyticsQuery,
  parsePagination,
  parseSearchInput,
} from "./queryInput";
import type { AnalyticsProvider } from "./types";

export type AnalyticsQueryAccess = "protected" | "public";

export interface AnalyticsHandlerOptions {
  readonly provider: AnalyticsProvider;
  readonly queryAccess: AnalyticsQueryAccess;
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    headers: { "cache-control": "private, no-store" },
    status,
  });

const requireParam = (
  params: Readonly<Record<string, string>>,
  key: string,
): string => {
  const value = params[key];
  if (value === undefined || value.length === 0) {
    throw new AnalyticsBadRequestError(`Missing route parameter: ${key}`);
  }
  return value;
};

const run = async (operation: () => Promise<Response>): Promise<Response> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AnalyticsBadRequestError) {
      return json({ error: error.message }, 400);
    }
    if (error instanceof AnalyticsPayloadTooLargeError) {
      return json({ error: error.message }, 413);
    }
    if (error instanceof AnalyticsScanLimitExceededError) {
      return json(
        {
          error: {
            code: "ANALYTICS_SCAN_LIMIT_EXCEEDED",
            limit: error.limit,
          },
        },
        503,
      );
    }
    throw error;
  }
};

const query = (
  access: AnalyticsQueryAccess,
  operation: () => Promise<unknown>,
): Promise<Response> => {
  if (access === "protected") {
    return Promise.resolve(json({ error: "Unauthorized" }, 401));
  }
  return run(async () => json(await operation(), 200));
};

export const createAnalyticsRouteHandlers = <TContext>(
  options: AnalyticsHandlerOptions,
): Record<string, RouteHandler<TContext>> => ({
  appendBundleEvent: async (_params, request) =>
    run(async () => {
      await options.provider.appendBundleEvent(
        await parseBundleEventRequest(request),
      );
      return new Response(null, { status: 204 });
    }),
  getBundleEventSummary: (params) =>
    query(options.queryAccess, () =>
      options.provider.getBundleEventSummary(requireParam(params, "id")),
    ),
  getBundleEventAnalytics: (params, request) =>
    query(options.queryAccess, () => {
      const input = parseAnalyticsQuery(request);
      return options.provider.getBundleEventAnalytics(
        requireParam(params, "id"),
        input.window,
        input.limit,
        input.offset,
      );
    }),
  getBundleEventOverview: () =>
    query(options.queryAccess, () => options.provider.getBundleEventOverview()),
  getActiveInstallationOverview: (_params, request) =>
    query(options.queryAccess, () =>
      options.provider.getActiveInstallationOverview(
        parseActiveInstallationInput(request),
      ),
    ),
  searchInstallations: (_params, request) =>
    query(options.queryAccess, () => {
      const input = parseSearchInput(request);
      return options.provider.searchInstallations(
        input.query,
        input.limit,
        input.offset,
      );
    }),
  getInstallationHistory: (params, request) =>
    query(options.queryAccess, () => {
      const input = parsePagination(request);
      return options.provider.getInstallationHistory(
        requireParam(params, "installId"),
        input.limit,
        input.offset,
      );
    }),
});

export const registerAnalyticsRoutes = (
  add: (method: string, path: string, handler: string) => void,
): void => {
  add("POST", "/events", "appendBundleEvent");
  add("GET", "/api/bundles/:id/events/summary", "getBundleEventSummary");
  add("GET", "/api/bundles/:id/events/analytics", "getBundleEventAnalytics");
  add("GET", "/api/installations/overview", "getBundleEventOverview");
  add("GET", "/api/installations/active", "getActiveInstallationOverview");
  add("GET", "/api/installations", "searchInstallations");
  add("GET", "/api/installations/:installId/events", "getInstallationHistory");
};
