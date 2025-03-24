import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";

const getCdnJson = async <T>({
  baseUrl,
  key,
  keyPairId,
  privateKey,
}: {
  baseUrl: string;
  key: string;
  keyPairId: string;
  privateKey: string;
}): Promise<T | null> => {
  try {
    const url = new URL(baseUrl);
    url.pathname = `/${key}`;

    // CloudFront 서명된 URL 생성
    const signedUrl = getSignedUrl({
      url: url.toString(),
      keyPairId: keyPairId,
      privateKey: privateKey,
      dateLessThan: new Date(Date.now() + 60 * 1000).toISOString(), // 60초 동안 유효
    });

    const res = await fetch(signedUrl, {
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
  {
    baseUrl,
    keyPairId,
    privateKey,
  }: {
    baseUrl: string;
    keyPairId: string;
    privateKey: string;
  },
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
    keyPairId,
    privateKey,
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
        keyPairId,
        privateKey,
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
