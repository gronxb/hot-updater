import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { mockClient } from "aws-sdk-client-mock";
import { groupBy } from "es-toolkit";
import { beforeEach, describe } from "vitest";
import { getUpdateInfo as getUpdateInfoFromS3 } from "./getUpdateInfo";

const s3Mock = mockClient(S3Client);

const createGetUpdateInfo =
  (s3: S3Client, bucketName: string) =>
  async (
    bundles: Bundle[],
    {
      appVersion,
      bundleId,
      platform,
      minBundleId = NIL_UUID,
      channel = "production",
    }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    if (bundles.length > 0) {
      // Mock target-app-versions.json
      const targetVersions = [
        ...new Set(bundles.map((b) => b.targetAppVersion)),
      ];
      s3Mock
        .on(GetObjectCommand, {
          Bucket: bucketName,
          Key: `${platform}/target-app-versions.json`,
        })
        .resolves({
          Body: {
            transformToString: () =>
              Promise.resolve(JSON.stringify(targetVersions)),
          },
        } as any);

      // Mock update.json for each version
      const bundlesByVersion = groupBy(bundles, (b) => b.targetAppVersion);

      // Set update.json response for each version
      for (const [version, versionBundles] of Object.entries(
        bundlesByVersion,
      )) {
        s3Mock
          .on(GetObjectCommand, {
            Bucket: bucketName,
            Key: `${platform}/${version}/update.json`,
          })
          .resolves({
            Body: {
              transformToString: () =>
                Promise.resolve(JSON.stringify(versionBundles)),
            },
          } as any);
      }
    } else {
      // Return NoSuchKey error when there are no bundles
      s3Mock.on(GetObjectCommand).rejects(new Error("NoSuchKey"));
    }

    return getUpdateInfoFromS3(s3, bucketName, {
      minBundleId,
      channel,
      appVersion,
      bundleId,
      platform,
    });
  };

describe("getUpdateInfo", () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: createGetUpdateInfo(new S3Client({}), "test-bucket"),
  });
});
