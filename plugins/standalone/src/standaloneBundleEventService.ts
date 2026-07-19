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

export const createBundleEventService = (
  config: StandaloneRepositoryConfig,
): DatabaseBundleEventService => {
  const routes = {
    appendEvent: () =>
      createRoute(defaultRoutes.appendEvent(), config.routes?.appendEvent?.()),
    bundleEventAnalytics: (bundleId: string) =>
      createRoute(
        defaultRoutes.bundleEventAnalytics(bundleId),
        config.routes?.bundleEventAnalytics?.(bundleId),
      ),
    bundleEventSummary: (bundleId: string) =>
      createRoute(
        defaultRoutes.bundleEventSummary(bundleId),
        config.routes?.bundleEventSummary?.(bundleId),
      ),
    bundleEventOverview: () =>
      createRoute(
        defaultRoutes.bundleEventOverview(),
        config.routes?.bundleEventOverview?.(),
      ),
    activeInstallationOverview: () =>
      createRoute(
        defaultRoutes.activeInstallationOverview(),
        config.routes?.activeInstallationOverview?.(),
      ),
    installationHistory: (installId: string) =>
      createRoute(
        defaultRoutes.installationHistory(installId),
        config.routes?.installationHistory?.(installId),
      ),
    installations: () =>
      createRoute(
        defaultRoutes.installations(),
        config.routes?.installations?.(),
      ),
  };
  const http = createStandaloneHttp(config);

  return {
    async appendBundleEvent(input) {
      const route = routes.appendEvent();
      const response = await fetch(http.buildUrl(route.path), {
        method: "POST",
        headers: http.headers(route.headers),
        body: JSON.stringify(input),
      });
      if (!response.ok) await http.requestFailed(response);
    },
    getBundleEventSummary(bundleId) {
      return http.load(
        routes.bundleEventSummary(bundleId),
        {},
        isBundleEventSummary,
        "Invalid bundle event summary response.",
      );
    },
    getBundleEventAnalytics(bundleId, window, limit, offset) {
      return http.load(
        routes.bundleEventAnalytics(bundleId),
        { window, limit: String(limit), offset: String(offset) },
        isBundleEventAnalytics,
        "Invalid bundle event analytics response.",
      );
    },
    getBundleEventOverview() {
      return http.load(
        routes.bundleEventOverview(),
        {},
        isBundleEventOverview,
        "Invalid bundle event overview response.",
      );
    },
    async getActiveInstallationOverview(input) {
      const normalized = normalizeActiveInput(input);
      const searchParams: Record<string, string> = {
        window: normalized.window,
      };
      if (normalized.userId !== undefined) {
        searchParams.userId = normalized.userId;
      }
      return http.load(
        routes.activeInstallationOverview(),
        searchParams,
        (value) => isActiveInstallationOverview(value, normalized.window),
        "Invalid active installation overview response.",
      );
    },
    searchInstallations(query, limit, offset) {
      return http.load(
        routes.installations(),
        { query, limit: String(limit), offset: String(offset) },
        (value): value is OffsetPaginationResult<InstallationSearchRow> =>
          isOffsetPaginationResult(value, isInstallationSearchRow),
        "Invalid installation search response.",
      );
    },
    getInstallationHistory(installId, limit, offset) {
      return http.load(
        routes.installationHistory(installId),
        { limit: String(limit), offset: String(offset) },
        (value): value is OffsetPaginationResult<InstallationHistoryRow> =>
          isOffsetPaginationResult(value, isInstallationHistoryRow),
        "Invalid installation history response.",
      );
    },
  };
};
