import type { Bundle, Platform } from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";

const getCloudFrontJson = async <T>(url: string) => {
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    return (await response.json()) as T[];
  } catch {
    return [];
  }
};

export const getUpdateInfo = async (
  cloudfrontBaseUrl: string,
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
  const targetAppVersions =
    await getCloudFrontJson<string>(targetAppVersionsUrl);

  const matchingVersions = filterCompatibleAppVersions(
    targetAppVersions ?? [],
    appVersion,
  );

  // 각 targetAppVersion에 대해 CloudFront URL을 사용해 update.json을 가져옴
  const results = await Promise.allSettled(
    matchingVersions.map((targetAppVersion) =>
      getCloudFrontJson<Bundle>(
        `${cloudfrontBaseUrl}/${platform}/${targetAppVersion}/update.json`,
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
