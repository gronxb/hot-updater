import type {
  DatabaseBundleEventService,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "@hot-updater/plugin-core";

import { createStandaloneHttp } from "./standaloneHttp";
import {
  isActiveInstallationOverview,
  isBundleEventAnalytics,
  isBundleEventOverview,
  isBundleEventSummary,
  isInstallationHistoryRow,
  isInstallationSearchRow,
  isOffsetPaginationResult,
} from "./standaloneResponseGuards";
import {
  createRoute,
  defaultRoutes,
  type StandaloneRepositoryConfig,
} from "./standaloneRoutes";

const MAX_USER_ID_LENGTH = 1024;

const normalizeActiveInput = (
  input: Parameters<
    DatabaseBundleEventService["getActiveInstallationOverview"]
  >[0],
) => {
  if (
    input.window !== "24h" &&
    input.window !== "7d" &&
    input.window !== "30d"
  ) {
    throw new TypeError("Invalid active installation window.");
  }
  if (input.userId !== undefined && typeof input.userId !== "string") {
    throw new TypeError("Invalid active installation userId.");
  }
  const userId = input.userId?.trim();
  if (userId && userId.length > MAX_USER_ID_LENGTH) {
    throw new TypeError("Invalid active installation userId.");
  }
  return userId ? { window: input.window, userId } : { window: input.window };
};

export const createBundleEventService = <TContext>(
  config: StandaloneRepositoryConfig<TContext>,
): DatabaseBundleEventService<TContext> => {
  const routes = {
    appendEvent: (context?: TContext) =>
      createRoute(
        defaultRoutes.appendEvent(),
        config.routes?.appendEvent?.(context),
      ),
    bundleEventAnalytics: (bundleId: string, context?: TContext) =>
      createRoute(
        defaultRoutes.bundleEventAnalytics(bundleId),
        config.routes?.bundleEventAnalytics?.(bundleId, context),
      ),
    bundleEventSummary: (bundleId: string, context?: TContext) =>
      createRoute(
        defaultRoutes.bundleEventSummary(bundleId),
        config.routes?.bundleEventSummary?.(bundleId, context),
      ),
    bundleEventOverview: (context?: TContext) =>
      createRoute(
        defaultRoutes.bundleEventOverview(),
        config.routes?.bundleEventOverview?.(context),
      ),
    activeInstallationOverview: (context?: TContext) =>
      createRoute(
        defaultRoutes.activeInstallationOverview(),
        config.routes?.activeInstallationOverview?.(context),
      ),
    installationHistory: (installId: string, context?: TContext) =>
      createRoute(
        defaultRoutes.installationHistory(installId),
        config.routes?.installationHistory?.(installId, context),
      ),
    installations: (context?: TContext) =>
      createRoute(
        defaultRoutes.installations(),
        config.routes?.installations?.(context),
      ),
  };
  const http = createStandaloneHttp(config);

  return {
    async appendBundleEvent(input, context) {
      const route = routes.appendEvent(context);
      const response = await fetch(http.buildUrl(route.path), {
        method: "POST",
        headers: http.headers(route.headers),
        body: JSON.stringify(input),
      });
      if (!response.ok) await http.requestFailed(response);
    },
    getBundleEventSummary(bundleId, context) {
      return http.load(
        routes.bundleEventSummary(bundleId, context),
        {},
        isBundleEventSummary,
        "Invalid bundle event summary response.",
      );
    },
    getBundleEventAnalytics(bundleId, window, limit, offset, context) {
      return http.load(
        routes.bundleEventAnalytics(bundleId, context),
        { window, limit: String(limit), offset: String(offset) },
        isBundleEventAnalytics,
        "Invalid bundle event analytics response.",
      );
    },
    getBundleEventOverview(context) {
      return http.load(
        routes.bundleEventOverview(context),
        {},
        isBundleEventOverview,
        "Invalid bundle event overview response.",
      );
    },
    async getActiveInstallationOverview(input, context) {
      const normalized = normalizeActiveInput(input);
      const searchParams: Record<string, string> = {
        window: normalized.window,
      };
      if (normalized.userId !== undefined) {
        searchParams.userId = normalized.userId;
      }
      return http.load(
        routes.activeInstallationOverview(context),
        searchParams,
        (value) => isActiveInstallationOverview(value, normalized.window),
        "Invalid active installation overview response.",
      );
    },
    searchInstallations(query, limit, offset, context) {
      return http.load(
        routes.installations(context),
        { query, limit: String(limit), offset: String(offset) },
        (value): value is OffsetPaginationResult<InstallationSearchRow> =>
          isOffsetPaginationResult(value, isInstallationSearchRow),
        "Invalid installation search response.",
      );
    },
    getInstallationHistory(installId, limit, offset, context) {
      return http.load(
        routes.installationHistory(installId, context),
        { limit: String(limit), offset: String(offset) },
        (value): value is OffsetPaginationResult<InstallationHistoryRow> =>
          isOffsetPaginationResult(value, isInstallationHistoryRow),
        "Invalid installation history response.",
      );
    },
  };
};
