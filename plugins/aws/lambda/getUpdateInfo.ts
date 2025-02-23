import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Bundle, Platform } from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";

const getS3Json = async (s3: S3Client, bucket: string, key: string) => {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const { Body } = await s3.send(command);
    if (!Body) {
      return null;
    }
    const jsonString = await Body.transformToString();
    return JSON.parse(jsonString);
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") {
      return null;
    }
    throw error;
  }
};

export const getUpdateInfo = async (
  s3: S3Client,
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
  const targetAppVersions = await getS3Json(
    s3,
    bucketName,
    `${platform}/target-app-versions.json`,
  );
  if (!targetAppVersions) {
    return null;
  }

  const matchingVersions = filterCompatibleAppVersions(
    targetAppVersions,
    appVersion,
  );
  if (!matchingVersions?.length) {
    return null;
  }

  const results = await Promise.allSettled(
    matchingVersions.map((targetAppVersion) =>
      getS3Json(s3, bucketName, `${platform}/${targetAppVersion}/update.json`),
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
