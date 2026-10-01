import { isDatabaseBusyError } from "@hot-updater/plugin-core/internal";

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

/** Seconds a client waits before it resends a request the busy database refused. */
const RETRY_AFTER_SECONDS = 5;

const json = (
  body: unknown,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  Response.json(body, {
    headers: { "cache-control": "private, no-store", ...headers },
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
    // Back-pressure: a busy database has not failed the request, so the
    // client may send it again after Retry-After. A 500 would read as a fault.
    // The warning keeps the overload visible to whoever runs the server.
    if (isDatabaseBusyError(error)) {
      console.warn(
        "[hot-updater] Insights answered 503: the database is busy.",
        error,
      );
      return json({ error: "Service unavailable" }, 503, {
        "retry-after": String(RETRY_AFTER_SECONDS),
      });
    }
    throw error;
  }
};

const query = (operation: () => Promise<unknown>): Promise<Response> =>
  run(async () => json(await operation(), 200));

/** Every Insights route: where it mounts, and the handler it runs. */
export const INSIGHTS_ROUTES = [
  {
    access: "client",
    method: "POST",
    path: "/events",
    handler: "appendBundleEvent",
  },
  { access: "admin", method: "GET", path: "/events", handler: "listEvents" },
  {
    access: "admin",
    method: "GET",
    path: "/overview",
    handler: "getReportingOverview",
  },
  {
    access: "admin",
    method: "GET",
    path: "/installations",
    handler: "pageInstallationsByCurrentUserId",
  },
  {
    access: "admin",
    method: "GET",
    path: "/installations/:installId/events",
    handler: "listInstallationEvents",
  },
  {
    access: "admin",
    method: "GET",
    path: "/installations/:installId",
    handler: "getInstallation",
  },
] as const;

export type InsightsRouteName = (typeof INSIGHTS_ROUTES)[number]["handler"];

export type InsightsRouteHandler = (
  params: Readonly<Record<string, string>>,
  request: Request,
) => Promise<Response>;

export const createInsightsRouteHandlers = (
  provider: InsightsProvider,
): Record<InsightsRouteName, InsightsRouteHandler> => ({
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
