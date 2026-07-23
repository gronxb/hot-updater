import type { AppUpdateAvailableInfo, AppUpdateInfo } from "@hot-updater/core";
import semver from "semver";

import {
  type AnalyticsRouteCapability,
  resolveReportedAnalyticsCapability,
} from "./db/analyticsCapability";
import {
  decodeMaybe,
  requirePlatformParam,
  requireRouteParam,
} from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const SDK_VERSION_HEADER = "Hot-Updater-SDK-Version";
const EXPLICIT_NO_UPDATE_MIN_SDK_VERSION = "0.31.0";

const supportsExplicitNoUpdateResponse = (request: Request): boolean => {
  const sdkVersion = request.headers.get(SDK_VERSION_HEADER)?.trim();
  if (!sdkVersion) return false;
  const normalizedSdkVersion = semver.valid(sdkVersion);
  return (
    normalizedSdkVersion !== null &&
    semver.gte(normalizedSdkVersion, EXPLICIT_NO_UPDATE_MIN_SDK_VERSION)
  );
};

const serializeUpdateInfo = (
  updateInfo: AppUpdateAvailableInfo | null,
  request: Request,
): string => {
  if (updateInfo) {
    return JSON.stringify(updateInfo satisfies AppUpdateInfo);
  }
  if (supportsExplicitNoUpdateResponse(request)) {
    return JSON.stringify({ status: "UP_TO_DATE" } satisfies AppUpdateInfo);
  }
  return JSON.stringify(null);
};

export const createUpdateRouteHandlers = <TContext>(
  mountedRouteCapability: AnalyticsRouteCapability,
): Record<string, RouteHandler<TContext>> => ({
  version: async (_params, _request, api) => {
    const capabilities = await resolveReportedAnalyticsCapability(
      api,
      mountedRouteCapability.eventIngestion,
      mountedRouteCapability.analyticsQueries,
    );
    return new Response(
      JSON.stringify({
        version: HOT_UPDATER_SERVER_VERSION,
        capabilities,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  },

  fingerprintUpdateWithCohort: async (params, request, api, context) => {
    const updateInfo = await api.getAppUpdateInfo(
      {
        _updateStrategy: "fingerprint",
        platform: requirePlatformParam(params),
        fingerprintHash: requireRouteParam(params, "fingerprintHash"),
        channel: requireRouteParam(params, "channel"),
        minBundleId: requireRouteParam(params, "minBundleId"),
        bundleId: requireRouteParam(params, "bundleId"),
        cohort: decodeMaybe(params.cohort),
      },
      context,
    );
    return new Response(serializeUpdateInfo(updateInfo, request), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  appVersionUpdateWithCohort: async (params, request, api, context) => {
    const updateInfo = await api.getAppUpdateInfo(
      {
        _updateStrategy: "appVersion",
        platform: requirePlatformParam(params),
        appVersion: requireRouteParam(params, "appVersion"),
        channel: requireRouteParam(params, "channel"),
        minBundleId: requireRouteParam(params, "minBundleId"),
        bundleId: requireRouteParam(params, "bundleId"),
        cohort: decodeMaybe(params.cohort),
      },
      context,
    );
    return new Response(serializeUpdateInfo(updateInfo, request), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
