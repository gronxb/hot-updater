import { S3Client, GetObjectCommand, NoSuchKey } from "@aws-sdk/client-s3";
import { streamToString } from "../src/utils/streamToString";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Bundle } from '@hot-updater/plugin-core'

export interface UpdateInfo {
  id: string;
  shouldForceUpdate: boolean;
  fileUrl: string | null;
  fileHash: string | null;
  status: "UPDATE" | "ROLLBACK";
}

const BUCKET_NAME = process.env.HOT_UPDATER_AWS_S3_BUCKET_NAME;
const METADATA_KEY = "update.json";
const s3 = new S3Client({ region: process.env.HOT_UPDATER_AWS_REGION });

export const getUpdateInfo = async ({
  platform,
  appVersion,
  bundleId,
}: {
  platform: "ios" | "android";
  appVersion: string;
  bundleId: string;
}): Promise<UpdateInfo | null> => {
  try {
    let bundles: Bundle[] = [];
    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: METADATA_KEY,
      });
      const response = await s3.send(command);
      if (!response.Body) throw new Error("Metadata file is empty");
      const bodyContents = await streamToString(response.Body);
      bundles = JSON.parse(bodyContents);
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      console.error("Error fetching metadata from S3:", error);
      throw error;
    }

    const platformBundles = bundles.filter((bundle) => bundle.platform === platform);

    const appVersionList = [...new Set(platformBundles.map((b) => b.targetAppVersion))];
    const targetAppVersionList = filterCompatibleAppVersions(appVersionList, appVersion);

    const updateCandidate = platformBundles
      .filter(
        (b) =>
          b.enabled &&
          b.id >= bundleId &&
          targetAppVersionList.includes(b.targetAppVersion)
      )
      .sort((a, b) => b.id.localeCompare(a.id))[0];

    if (updateCandidate) {
      return {
        id: updateCandidate.id,
        shouldForceUpdate: updateCandidate.shouldForceUpdate,
        fileUrl: updateCandidate.fileUrl,
        fileHash: updateCandidate.fileHash,
        status: "UPDATE",
      };
    }

    const rollbackCandidate = platformBundles
      .filter((b) => b.enabled && b.id < bundleId)
      .sort((a, b) => b.id.localeCompare(a.id))[0];

    if (rollbackCandidate) {
      return {
        id: rollbackCandidate.id,
        shouldForceUpdate: true,
        fileUrl: rollbackCandidate.fileUrl,
        fileHash: rollbackCandidate.fileHash,
        status: "ROLLBACK",
      };
    }

    return null;
  } catch (error) {
    console.error("Unhandled error in getUpdateInfo:", error);
    return null;
  }
};