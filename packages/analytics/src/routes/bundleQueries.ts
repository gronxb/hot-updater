import type {
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "@hot-updater/server/internal/first-party-plugin";

import type { AnalyticsProvider } from "../provider";
import {
  parseAnalyticsQuery,
  parseEmptyInput,
  type AnalyticsQueryInput,
} from "./queryInput";
import {
  createAnalyticsInputParser,
  queryAccess,
  requireRouteParam,
  scanSafe,
  type AnalyticsRouteInput,
} from "./support";

export type AnalyticsRouteOptions = {
  readonly queryAccess: "protected" | "public";
};

export function createBundleQueryRoutes(
  provider: AnalyticsProvider,
  options: AnalyticsRouteOptions,
): readonly HotUpdaterServerRoute[] {
  return Object.freeze([
    Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getBundleEventSummary",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseEmptyInput,
      ),
      method: "GET",
      path: "/api/bundles/:id/events/summary",
      async handle(
        context: HotUpdaterRouteContext,
        input: AnalyticsRouteInput<undefined>,
      ) {
        if (input.kind === "response") return input.response;
        const bundleId = requireRouteParam(context.route.params, "id");
        return scanSafe(() => provider.getBundleEventSummary(bundleId));
      },
    }),
    Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getBundleEventAnalytics",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseAnalyticsQuery,
      ),
      method: "GET",
      path: "/api/bundles/:id/events/analytics",
      async handle(
        context: HotUpdaterRouteContext,
        input: AnalyticsRouteInput<AnalyticsQueryInput>,
      ) {
        if (input.kind === "response") return input.response;
        const bundleId = requireRouteParam(context.route.params, "id");
        return scanSafe(() =>
          provider.getBundleEventAnalytics(
            bundleId,
            input.value.window,
            input.value.limit,
            input.value.offset,
          ),
        );
      },
    }),
    Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getBundleEventOverview",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseEmptyInput,
      ),
      method: "GET",
      path: "/api/installations/overview",
      async handle(
        _context: HotUpdaterRouteContext,
        input: AnalyticsRouteInput<undefined>,
      ) {
        if (input.kind === "response") return input.response;
        return scanSafe(() => provider.getBundleEventOverview());
      },
    }),
  ] satisfies readonly HotUpdaterServerRoute[]);
}
