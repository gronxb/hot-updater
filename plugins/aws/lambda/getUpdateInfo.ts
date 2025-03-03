import type { Bundle, Platform } from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import { getUpdateInfo as getUpdateInfoJS } from "@hot-updater/js";

const getCloudFrontJson = async <T>(url: string, internalAuthToken: string) => {
  try {
    const response = await fetch(url, {
      headers: {
        "x-internal-auth-token": internalAuthToken,
      },
    });
    if (!response.ok) {
      return [];
    }
    return (await response.json()) as T[];
  } catch {
    return [];
  }
};

export const getUpdateInfo = async (
  cloudfrontBaseUrl: string,
  internalAuthToken: string,
  {
    platform,
    appVersion,
    bundleId,
  }: {
    platform: Platform;
    appVersion: string;
    bundleId: string;
  },
) => {
  const targetAppVersionsUrl = `${cloudfrontBaseUrl}/${platform}/target-app-versions.json`;
  const targetAppVersions = await getCloudFrontJson<string>(
    targetAppVersionsUrl,
    internalAuthToken,
  );

  const matchingVersions = filterCompatibleAppVersions(
    targetAppVersions ?? [],
    appVersion,
  );

  const results = await Promise.allSettled(
    matchingVersions.map((targetAppVersion) =>
      getCloudFrontJson<Bundle>(
        `${cloudfrontBaseUrl}/${platform}/${targetAppVersion}/update.json`,
        internalAuthToken,
      ),
    ),
  );

  const bundles = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );
  return getUpdateInfoJS(bundles, {
    platform,
    bundleId,
    appVersion,
  });
};
