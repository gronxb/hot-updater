import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe } from "vitest";
import { getUpdateInfo as getUpdateInfoFromS3 } from "./getUpdateInfo";

const s3Mock = mockClient(S3Client);

const createGetUpdateInfo =
  (s3: S3Client, bucketName: string) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    if (bundles.length > 0) {
      // Mock S3 responses for target-app-versions.json
      s3Mock
        .on(GetObjectCommand, {
          Bucket: bucketName,
          Key: `${platform}/target-app-versions.json`,
        })
        .resolves({
          Body: {
            transformToString: () =>
              Promise.resolve(
                JSON.stringify(bundles.map((b) => b.targetAppVersion)),
              ),
          },
        } as any);

      // Mock S3 responses for each bundle's update.json
      const bundlesByVersion = bundles.reduce(
        (acc, bundle) => {
          const version = bundle.targetAppVersion;
          if (!acc[version]) {
            acc[version] = [];
          }
          acc[version].push(bundle);
          return acc;
        },
        {} as Record<string, Bundle[]>,
      );

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
      // When no bundles, mock empty responses
      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: () => Promise.resolve("[]"),
        },
      } as any);
    }

    return getUpdateInfoFromS3(s3, bucketName, {
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
