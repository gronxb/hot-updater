import type { RouteHandler } from "../handlerTypes";
import {
  InsightsBadRequestError,
  InsightsPayloadTooLargeError,
} from "./errors";
import { parseBundleEventRequest } from "./eventInput";
import {
  parseReportingOverviewInput,
  parseEventPageInput,
  parseUserInstallationPageInput,
} from "./queryInput";
import type { InsightsProvider } from "./types";

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
    throw new InsightsBadRequestError(`Missing route parameter: ${key}`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InsightsBadRequestError(`Invalid route parameter: ${key}`);
  }
};

const run = async (operation: () => Promise<Response>): Promise<Response> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InsightsBadRequestError) {
      return json({ error: error.message }, 400);
    }
    if (error instanceof InsightsPayloadTooLargeError) {
      return json({ error: error.message }, 413);
    }
    throw error;
  }
};

const query = (operation: () => Promise<unknown>): Promise<Response> =>
  run(async () => json(await operation(), 200));

export const createInsightsRouteHandlers = (
  provider: InsightsProvider,
): Record<string, RouteHandler> => ({
  appendBundleEvent: async (_params, request) =>
    run(async () => {
      await provider.appendBundleEvent(await parseBundleEventRequest(request));
      return new Response(null, { status: 204 });
    }),
  getReportingOverview: (_params, request) =>
    query(() =>
      provider.getReportingOverview(parseReportingOverviewInput(request)),
    ),
  getInstallation: (params) =>
    run(async () => {
      const installation = await provider.getInstallation({
        installId: requireParam(params, "installId"),
      });
      return installation === null
        ? json({ error: "Installation not found" }, 404)
        : json(installation, 200);
    }),
  listEvents: (_params, request) =>
    query(() => provider.listEvents(parseEventPageInput(request))),
  listInstallationEvents: (params, request) =>
    query(() =>
      provider.listInstallationEvents({
        ...parseEventPageInput(request),
        installId: requireParam(params, "installId"),
      }),
    ),
  pageInstallationsByCurrentUserId: (_params, request) =>
    query(() =>
      provider.pageInstallationsByCurrentUserId(
        parseUserInstallationPageInput(request),
      ),
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
  add("GET", "/events", "listEvents");
  add("GET", "/overview", "getReportingOverview");
  add("GET", "/installations", "pageInstallationsByCurrentUserId");
  add("GET", "/installations/:installId/events", "listInstallationEvents");
  add("GET", "/installations/:installId", "getInstallation");
};
