import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import {
  type AppVersionGetBundlesArgs,
  type Bundle,
  type FingerprintGetBundlesArgs,
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

    const signedUrl = getSignedUrl({
      url: url.toString(),
      keyPairId: keyPairId,
      privateKey: privateKey,
      dateLessThan: new Date(Date.now() + 60 * 1000).toISOString(),
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
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy({ baseUrl, keyPairId, privateKey }, args);
    case "fingerprint":
      return fingerprintStrategy({ baseUrl, keyPairId, privateKey }, args);
    default:
      return null;
  }
};

const appVersionStrategy = async (
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
    deviceId,
  }: AppVersionGetBundlesArgs,
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
    deviceId,
    _updateStrategy: "appVersion",
  });
};

const fingerprintStrategy = async (
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
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    deviceId,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const result = await getCdnJson<Bundle[]>({
    baseUrl,
    key: `${channel}/${platform}/${fingerprintHash}/update.json`,
    keyPairId,
    privateKey,
  });
  console.log(
    "result",
    `${channel}/${platform}/${fingerprintHash}/update.json`,
    result,
  );

  return getUpdateInfoJS(result ?? [], {
    platform,
    bundleId,
    fingerprintHash,
    minBundleId,
    channel,
    deviceId,
    _updateStrategy: "fingerprint",
  });
};
