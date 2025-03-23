import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
  signToken,
} from "@hot-updater/js";

const getCdnJson = async <T>({
  baseUrl,
  key,
  jwtSecret,
}: {
  baseUrl: string;
  key: string;
  jwtSecret: string;
}): Promise<T | null> => {
  try {
    const url = new URL(baseUrl);
    url.pathname = `/${key}`;
    url.searchParams.set("token", await signToken(key, jwtSecret));
    const res = await fetch(url.toString(), {
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      return null;
    }
    return res.json() as T;
  } catch {
    return null;
  }
};

export const getUpdateInfo = async (
  { baseUrl, jwtSecret }: { baseUrl: string; jwtSecret: string },
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const targetAppVersions = await getCdnJson<string[]>({
    baseUrl,
    key: `${channel}/${platform}/target-app-versions.json`,
    jwtSecret,
  });

  const matchingVersions = filterCompatibleAppVersions(
    targetAppVersions ?? [],
    appVersion,
  );

  const results = await Promise.allSettled(
    matchingVersions.map((targetAppVersion) =>
      getCdnJson({
        baseUrl,
        key: `${channel}/${platform}/${targetAppVersion}/update.json`,
        jwtSecret,
      }),
    ),
  );

  const bundles = results
    .filter(
      (r): r is PromiseFulfilledResult<Bundle[]> => r.status === "fulfilled",
    )
    .flatMap((r) => r.value ?? []);

  return getUpdateInfoJS(bundles, {
    platform,
    bundleId,
    appVersion,
    minBundleId,
    channel,
  });
};
