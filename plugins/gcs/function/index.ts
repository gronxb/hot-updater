import functions from "@google-cloud/functions-framework";
import type { Bundle, Platform } from "@hot-updater/core";
import { getJsonFromGCS, getPublicDownloadURL } from "../src/utils/gcs";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";

declare global {
  var HotUpdater: {
    GCS_BUCKET_NAME: string;
  };
}

const bucketName = HotUpdater.GCS_BUCKET_NAME;

async function signUpdateInfoFileUrl(updateInfo) {
  if (updateInfo?.fileUrl) {
    updateInfo.fileUrl = await getPublicDownloadURL(
      bucketName,
      updateInfo.fileUrl,
    );
  }
  return updateInfo;
}

export const getUpdateInfo = async (
  bucketName: string,
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
  const targetAppVersions = await getJsonFromGCS(
    bucketName,
    `${platform}/target-app-versions.json`,
  );

  const matchingVersions = filterCompatibleAppVersions(
    targetAppVersions ?? [],
    appVersion,
  );

  const results = await Promise.allSettled(
    matchingVersions.map((targetAppVersion) =>
      getJsonFromGCS(bucketName, `${platform}/${targetAppVersion}/update.json`),
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
  });
};

functions.http("get-version", async (req, res) => {
  try {
    const bundleId = req.headers["x-bundle-id"] as string | undefined;
    const appPlatform = req.headers["x-app-platform"] as
      | "ios"
      | "android"
      | undefined;

    const appVersion = req.headers["x-app-version"] as string | undefined;

    if (!bundleId || !appPlatform || !appVersion) {
      return res.status(400).send({ error: "Missing required headers." });
    }

    const updateInfo = await getUpdateInfo(bucketName, {
      bundleId,
      platform: appPlatform,
      appVersion,
    });
    if (!updateInfo) {
      return res.status(404).send();
    }

    const finalInfo = await signUpdateInfoFileUrl(updateInfo);
    res.json(finalInfo);
  } catch (error) {
    console.error("Internal Server Error:", error);
    res.status(500).send({ error: "Internal Server Error" });
  }
});
