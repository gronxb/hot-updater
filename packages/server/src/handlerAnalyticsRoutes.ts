import type {
  ActiveInstallationWindow,
  BundleEventAnalyticsWindow,
} from "./db/types";
import { supportsAnalytics } from "./db/types";
import { HandlerBadRequestError } from "./handlerErrors";
import {
  parseNonNegativeIntegerSearchParam,
  parsePositiveIntegerSearchParam,
  requireRouteParam,
} from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";

const EVENT_LIST_BOUNDS = { defaultValue: 50, maxValue: 100 } as const;
const MAX_USER_ID_LENGTH = 1024;

const parseBundleEventAnalyticsWindow = (
  url: URL,
): BundleEventAnalyticsWindow => {
  const value = url.searchParams.get("window") ?? "24h";
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  throw new HandlerBadRequestError(
    "The 'window' query parameter must be one of '24h', '7d', '30d', or 'all'.",
  );
};

const parseActiveInstallationInput = (
  url: URL,
): { readonly window: ActiveInstallationWindow; readonly userId?: string } => {
  const windows = url.searchParams.getAll("window");
  if (windows.length > 1) {
    throw new HandlerBadRequestError(
      "The 'window' query parameter must be provided at most once.",
    );
  }
  const window = windows[0] ?? "30d";
  if (window !== "24h" && window !== "7d" && window !== "30d") {
    throw new HandlerBadRequestError(
      "The 'window' query parameter must be one of '24h', '7d', or '30d'.",
    );
  }
  const userIds = url.searchParams.getAll("userId");
  if (userIds.length > 1) {
    throw new HandlerBadRequestError(
      "The 'userId' query parameter must be provided at most once.",
    );
  }
  const userId = userIds[0];
  if (
    userId !== undefined &&
    (userId.length === 0 || userId.length > MAX_USER_ID_LENGTH)
  ) {
    throw new HandlerBadRequestError("Invalid 'userId' query parameter.");
  }
  return userId === undefined ? { window } : { window, userId };
};

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export const createAnalyticsRouteHandlers = <TContext>(): Record<
  string,
  RouteHandler<TContext>
> => ({
  getBundleEventSummary: async (params, _request, api, context) => {
    if (!supportsAnalytics(api)) return new Response(null, { status: 404 });
    return jsonResponse(
      await api.getBundleEventSummary(requireRouteParam(params, "id"), context),
    );
  },

  getBundleEventAnalytics: async (params, request, api, context) => {
    if (!supportsAnalytics(api)) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    return jsonResponse(
      await api.getBundleEventAnalytics(
        requireRouteParam(params, "id"),
        parseBundleEventAnalyticsWindow(url),
        parsePositiveIntegerSearchParam(url, "limit", EVENT_LIST_BOUNDS),
        parseNonNegativeIntegerSearchParam(url, "offset", 0),
        context,
      ),
    );
  },

  getBundleEventOverview: async (_params, _request, api, context) => {
    if (!supportsAnalytics(api)) return new Response(null, { status: 404 });
    return jsonResponse(await api.getBundleEventOverview(context));
  },

  getActiveInstallationOverview: async (_params, request, api, context) => {
    if (!supportsAnalytics(api)) return new Response(null, { status: 404 });
    return jsonResponse(
      await api.getActiveInstallationOverview(
        parseActiveInstallationInput(new URL(request.url)),
        context,
      ),
    );
  },

  searchInstallations: async (_params, request, api, context) => {
    if (!supportsAnalytics(api)) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    return jsonResponse(
      await api.searchInstallations(
        url.searchParams.get("query")?.trim() ?? "",
        parsePositiveIntegerSearchParam(url, "limit", EVENT_LIST_BOUNDS),
        parseNonNegativeIntegerSearchParam(url, "offset", 0),
        context,
      ),
    );
  },

  getInstallationHistory: async (params, request, api, context) => {
    if (!supportsAnalytics(api)) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    return jsonResponse(
      await api.getInstallationHistory(
        requireRouteParam(params, "installId"),
        parsePositiveIntegerSearchParam(url, "limit", EVENT_LIST_BOUNDS),
        parseNonNegativeIntegerSearchParam(url, "offset", 0),
        context,
      ),
    );
  },
});
