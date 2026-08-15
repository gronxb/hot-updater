import type { AppUpdateAvailableInfo, AppUpdateInfo } from "@hot-updater/core";
import { isGreaterOrEqual, normalize } from "verkit";

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
  const normalizedSdkVersion = normalize(sdkVersion);
  return (
    normalizedSdkVersion !== null &&
    isGreaterOrEqual(normalizedSdkVersion, EXPLICIT_NO_UPDATE_MIN_SDK_VERSION)
  );
};

const serializeUpdateInfo = (
  updateInfo: AppUpdateAvailableInfo | null,
  request: Request,
): string => {
  if (updateInfo) {
    const resolveUrl = (url: string) => new URL(url, request.url).toString();
    const changedAssets = updateInfo.changedAssets
      ? Object.fromEntries(
          Object.entries(updateInfo.changedAssets).map(([path, asset]) => [
            path,
            {
              ...asset,
              ...(asset.file
                ? { file: { ...asset.file, url: resolveUrl(asset.file.url) } }
                : {}),
              ...(asset.patch
                ? {
                    patch: {
                      ...asset.patch,
                      patchUrl: resolveUrl(asset.patch.patchUrl),
                    },
                  }
                : {}),
            },
          ]),
        )
      : updateInfo.changedAssets;
    return JSON.stringify({
      ...updateInfo,
      fileUrl:
        updateInfo.fileUrl === null ? null : resolveUrl(updateInfo.fileUrl),
      ...(updateInfo.manifestUrl === undefined
        ? {}
        : {
            manifestUrl:
              updateInfo.manifestUrl === null
                ? null
                : resolveUrl(updateInfo.manifestUrl),
          }),
      ...(changedAssets === undefined ? {} : { changedAssets }),
    } satisfies AppUpdateInfo);
  }
  if (supportsExplicitNoUpdateResponse(request)) {
    return JSON.stringify({ status: "UP_TO_DATE" } satisfies AppUpdateInfo);
  }
  return JSON.stringify(null);
};

export const createUpdateRouteHandlers = (): Record<string, RouteHandler> => ({
  version: async () => {
    return new Response(
      JSON.stringify({
        version: HOT_UPDATER_SERVER_VERSION,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  },

  fingerprintUpdateWithCohort: async (params, request, api) => {
    const updateInfo = await api.getAppUpdateInfo({
      _updateStrategy: "fingerprint",
      platform: requirePlatformParam(params),
      fingerprintHash: requireRouteParam(params, "fingerprintHash"),
      channel: requireRouteParam(params, "channel"),
      minBundleId: requireRouteParam(params, "minBundleId"),
      bundleId: requireRouteParam(params, "bundleId"),
      cohort: decodeMaybe(params.cohort),
    });
    return new Response(serializeUpdateInfo(updateInfo, request), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  appVersionUpdateWithCohort: async (params, request, api) => {
    const updateInfo = await api.getAppUpdateInfo({
      _updateStrategy: "appVersion",
      platform: requirePlatformParam(params),
      appVersion: requireRouteParam(params, "appVersion"),
      channel: requireRouteParam(params, "channel"),
      minBundleId: requireRouteParam(params, "minBundleId"),
      bundleId: requireRouteParam(params, "bundleId"),
      cohort: decodeMaybe(params.cohort),
    });
    return new Response(serializeUpdateInfo(updateInfo, request), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
