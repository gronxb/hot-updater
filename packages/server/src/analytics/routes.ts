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

const query = (operation: () => Promise<unknown>): Promise<Response> =>
  run(async () => json(await operation(), 200));

export const createAnalyticsRouteHandlers = (
  provider: AnalyticsProvider,
): Record<string, RouteHandler> => ({
  appendBundleEvent: async (_params, request) =>
    run(async () => {
      await provider.appendBundleEvent(await parseBundleEventRequest(request));
      return new Response(null, { status: 204 });
    }),
  getBundleEventSummary: (params) =>
    query(() => provider.getBundleEventSummary(requireParam(params, "id"))),
  getBundleEventAnalytics: (params, request) =>
    query(() => {
      const input = parseAnalyticsQuery(request);
      return provider.getBundleEventAnalytics(
        requireParam(params, "id"),
        input.window,
        input.limit,
        input.offset,
      );
    }),
  getBundleEventOverview: () => query(() => provider.getBundleEventOverview()),
  getActiveInstallationOverview: (_params, request) =>
    query(() =>
      provider.getActiveInstallationOverview(
        parseActiveInstallationInput(request),
      ),
    ),
  searchInstallations: (_params, request) =>
    query(() => {
      const input = parseSearchInput(request);
      return provider.searchInstallations(
        input.query,
        input.limit,
        input.offset,
      );
    }),
  getInstallationHistory: (params, request) =>
    query(() => {
      const input = parsePagination(request);
      return provider.getInstallationHistory(
        requireParam(params, "installId"),
        input.limit,
        input.offset,
      );
    }),
});

export const registerAnalyticsClientRoutes = (
  add: (method: string, path: string, handler: string) => void,
): void => {
  add("POST", "/events", "appendBundleEvent");
};

export const registerAnalyticsAdminRoutes = (
  add: (method: string, path: string, handler: string) => void,
): void => {
  add("GET", "/bundles/:id/events/summary", "getBundleEventSummary");
  add("GET", "/bundles/:id/events/analytics", "getBundleEventAnalytics");
  add("GET", "/installations/overview", "getBundleEventOverview");
  add("GET", "/installations/active", "getActiveInstallationOverview");
  add("GET", "/installations", "searchInstallations");
  add("GET", "/installations/:installId/events", "getInstallationHistory");
};
