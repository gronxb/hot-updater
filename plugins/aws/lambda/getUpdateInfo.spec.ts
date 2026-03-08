import type {
  AppVersionGetBundlesArgs,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { beforeEach, describe, vi } from "vitest";
import { getUpdateInfo as getUpdateInfoFromS3 } from "./getUpdateInfo";

const createGetUpdateInfo =
  () =>
  async (
    bundles: Bundle[],
    args: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    const objects: Record<string, unknown> = {};

    if (args._updateStrategy === "appVersion") {
      const { platform, channel = "production" } =
        args as AppVersionGetBundlesArgs;

      if (bundles.length > 0) {
        const targetVersions = [
          ...new Set(bundles.map((b) => b.targetAppVersion).filter(Boolean)),
        ];
        const targetVersionsPath = `${channel}/${platform}/target-app-versions.json`;
        objects[targetVersionsPath] = targetVersions;

        const bundlesByVersion: Record<string, Bundle[]> = {};
        for (const bundle of bundles) {
          if (!bundle.targetAppVersion) {
            continue;
          }

          if (!bundlesByVersion[bundle.targetAppVersion]) {
            bundlesByVersion[bundle.targetAppVersion] = [];
          }
          bundlesByVersion[bundle.targetAppVersion].push(bundle);
        }

        for (const targetVersion of targetVersions) {
          if (!targetVersion) {
            continue;
          }

          const updatePath = `${channel}/${platform}/${targetVersion}/update.json`;
          objects[updatePath] = bundlesByVersion[targetVersion];
        }
      }
    } else if (args._updateStrategy === "fingerprint") {
      for (const bundle of bundles) {
        if (!bundle.fingerprintHash) {
          continue;
        }

        const updatePath = `${bundle.channel}/${bundle.platform}/${bundle.fingerprintHash}/update.json`;
        const existingBundles = objects[updatePath];

        if (Array.isArray(existingBundles)) {
          existingBundles.push(bundle);
        } else {
          objects[updatePath] = [bundle];
        }
      }
    }

    const readManifestJson = async <T>(key: string): Promise<T | null> => {
      if (key in objects) {
        return objects[key] as T;
      }
      return null;
    };

    return getUpdateInfoFromS3(
      {
        bucketName: "test-bucket",
        region: "ap-northeast-2",
        readManifestJson,
      },
      args,
    );
  };

describe("getUpdateInfo (S3 based)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: createGetUpdateInfo(),
  });
});
