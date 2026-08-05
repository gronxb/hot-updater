import type {
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "@hot-updater/server/internal/first-party-plugin";

import type { ActiveInstallationInput } from "../domain";
import type { AnalyticsProvider } from "../provider";
import type { AnalyticsRouteOptions } from "./bundleQueries";
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
  scanSafe,
  type AnalyticsRouteInput,
} from "./support";

export const createInstallationQueryRoutes = (
  provider: AnalyticsProvider,
  options: AnalyticsRouteOptions,
): readonly HotUpdaterServerRoute[] =>
  Object.freeze([
    Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getActiveInstallationOverview",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseActiveInstallationInput,
      ),
      method: "GET",
      path: "/api/installations/active",
      async handle(
        _context: HotUpdaterRouteContext,
        input: AnalyticsRouteInput<ActiveInstallationInput>,
      ) {
        if (input.kind === "response") return input.response;
        return scanSafe(() =>
          provider.getActiveInstallationOverview(input.value),
        );
      },
    }),
    Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.searchInstallations",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parseSearchInput,
      ),
      method: "GET",
      path: "/api/installations",
      async handle(
        _context: HotUpdaterRouteContext,
        input: AnalyticsRouteInput<
          PaginationInput & { readonly query: string }
        >,
      ) {
        if (input.kind === "response") return input.response;
        return scanSafe(() =>
          provider.searchInstallations(
            input.value.query,
            input.value.limit,
            input.value.offset,
          ),
        );
      },
    }),
    Object.freeze({
      access: queryAccess(options.queryAccess),
      id: "analytics.getInstallationHistory",
      input: createAnalyticsInputParser(
        provider,
        "analyticsQueries",
        parsePagination,
      ),
      method: "GET",
      path: "/api/installations/:installId/events",
      async handle(
        context: HotUpdaterRouteContext,
        input: AnalyticsRouteInput<PaginationInput>,
      ) {
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
    }),
  ] satisfies readonly HotUpdaterServerRoute[]);
