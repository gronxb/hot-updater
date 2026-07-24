import type { HotUpdaterServerRoute } from "@hot-updater/server/internal/first-party-plugin";

import type { BundleEventAnalyticsWindow } from "../domain";
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
  requireRuntimeCapability,
  scanSafe,
  type AnalyticsRouteInput,
} from "./support";

export interface AnalyticsRouteOptions {
  readonly queryAccess: "protected" | "public";
}

export const getBundleEventSummaryOperation = Object.freeze({
  name: "getBundleEventSummary",
  createRoute(
    provider: AnalyticsProvider,
    options: AnalyticsRouteOptions,
  ): HotUpdaterServerRoute<AnalyticsRouteInput<undefined>> {
    return Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getBundleEventSummary",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseEmptyInput,
      ),
      method: "GET",
      path: "/api/bundles/:id/events/summary",
      async handle(context, input) {
        if (input.kind === "response") return input.response;
        const bundleId = requireRouteParam(context.route.params, "id");
        return scanSafe(() => provider.getBundleEventSummary(bundleId));
      },
    } satisfies HotUpdaterServerRoute<AnalyticsRouteInput<undefined>>);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async (bundleId: string) => {
      await requireRuntimeCapability(
        provider,
        "analyticsQueries",
        "getBundleEventSummary",
      );
      return provider.getBundleEventSummary(bundleId);
    };
  },
});

export const getBundleEventAnalyticsOperation = Object.freeze({
  name: "getBundleEventAnalytics",
  createRoute(
    provider: AnalyticsProvider,
    options: AnalyticsRouteOptions,
  ): HotUpdaterServerRoute<AnalyticsRouteInput<AnalyticsQueryInput>> {
    return Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getBundleEventAnalytics",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseAnalyticsQuery,
      ),
      method: "GET",
      path: "/api/bundles/:id/events/analytics",
      async handle(context, input) {
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
    } satisfies HotUpdaterServerRoute<
      AnalyticsRouteInput<AnalyticsQueryInput>
    >);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async (
      bundleId: string,
      window: BundleEventAnalyticsWindow,
      limit: number,
      offset: number,
    ) => {
      await requireRuntimeCapability(
        provider,
        "analyticsQueries",
        "getBundleEventAnalytics",
      );
      return provider.getBundleEventAnalytics(bundleId, window, limit, offset);
    };
  },
});

export const getBundleEventOverviewOperation = Object.freeze({
  name: "getBundleEventOverview",
  createRoute(
    provider: AnalyticsProvider,
    options: AnalyticsRouteOptions,
  ): HotUpdaterServerRoute<AnalyticsRouteInput<undefined>> {
    return Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getBundleEventOverview",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseEmptyInput,
      ),
      method: "GET",
      path: "/api/installations/overview",
      async handle(_context, input) {
        if (input.kind === "response") return input.response;
        return scanSafe(() => provider.getBundleEventOverview());
      },
    } satisfies HotUpdaterServerRoute<AnalyticsRouteInput<undefined>>);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async () => {
      await requireRuntimeCapability(
        provider,
        "analyticsQueries",
        "getBundleEventOverview",
      );
      return provider.getBundleEventOverview();
    };
  },
});
