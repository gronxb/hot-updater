import type { HotUpdaterServerRoute } from "@hot-updater/server/internal/first-party-plugin";

import type { ActiveInstallationInput } from "../domain";
import type { AnalyticsProvider } from "../provider";
import type { AnalyticsRouteOptions } from "./bundleOperations";
import {
  parseActiveInstallationInput,
  parsePagination,
  parseSearchInput,
  type PaginationInput,
} from "./queryInput";
import {
  createAnalyticsInputParser,
  queryAccess,
  requireRouteParam,
  requireRuntimeCapability,
  scanSafe,
  type AnalyticsRouteInput,
} from "./support";

export const getActiveInstallationOverviewOperation = Object.freeze({
  name: "getActiveInstallationOverview",
  createRoute(
    provider: AnalyticsProvider,
    options: AnalyticsRouteOptions,
  ): HotUpdaterServerRoute<AnalyticsRouteInput<ActiveInstallationInput>> {
    return Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getActiveInstallationOverview",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseActiveInstallationInput,
      ),
      method: "GET",
      path: "/api/installations/active",
      async handle(_context, input) {
        if (input.kind === "response") return input.response;
        return scanSafe(() =>
          provider.getActiveInstallationOverview(input.value),
        );
      },
    } satisfies HotUpdaterServerRoute<
      AnalyticsRouteInput<ActiveInstallationInput>
    >);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async (input: ActiveInstallationInput) => {
      await requireRuntimeCapability(
        provider,
        "analyticsQueries",
        "getActiveInstallationOverview",
      );
      return provider.getActiveInstallationOverview(input);
    };
  },
});

export const searchInstallationsOperation = Object.freeze({
  name: "searchInstallations",
  createRoute(
    provider: AnalyticsProvider,
    options: AnalyticsRouteOptions,
  ): HotUpdaterServerRoute<
    AnalyticsRouteInput<PaginationInput & { readonly query: string }>
  > {
    return Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.searchInstallations",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseSearchInput,
      ),
      method: "GET",
      path: "/api/installations",
      async handle(_context, input) {
        if (input.kind === "response") return input.response;
        return scanSafe(() =>
          provider.searchInstallations(
            input.value.query,
            input.value.limit,
            input.value.offset,
          ),
        );
      },
    } satisfies HotUpdaterServerRoute<
      AnalyticsRouteInput<PaginationInput & { readonly query: string }>
    >);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async (query: string, limit: number, offset: number) => {
      await requireRuntimeCapability(
        provider,
        "analyticsQueries",
        "searchInstallations",
      );
      return provider.searchInstallations(query, limit, offset);
    };
  },
});

export const getInstallationHistoryOperation = Object.freeze({
  name: "getInstallationHistory",
  createRoute(
    provider: AnalyticsProvider,
    options: AnalyticsRouteOptions,
  ): HotUpdaterServerRoute<AnalyticsRouteInput<PaginationInput>> {
    return Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getInstallationHistory",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parsePagination,
      ),
      method: "GET",
      path: "/api/installations/:installId/events",
      async handle(context, input) {
        if (input.kind === "response") return input.response;
        const installId = requireRouteParam(context.route.params, "installId");
        return scanSafe(() =>
          provider.getInstallationHistory(
            installId,
            input.value.limit,
            input.value.offset,
          ),
        );
      },
    } satisfies HotUpdaterServerRoute<AnalyticsRouteInput<PaginationInput>>);
  },
  createRuntimeMethod(provider: AnalyticsProvider) {
    return async (installId: string, limit: number, offset: number) => {
      await requireRuntimeCapability(
        provider,
        "analyticsQueries",
        "getInstallationHistory",
      );
      return provider.getInstallationHistory(installId, limit, offset);
    };
  },
});
