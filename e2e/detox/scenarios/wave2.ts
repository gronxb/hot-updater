import { archiveToDiffScenario } from "./archive-to-diff.ts";
import type { DetoxScenarioDefinition } from "./types.ts";

export const wave2Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "multi-asset-replacement",
    wave: 2,
    steps: [
      { action: "launch", kind: "device", stage: "launch built-in app" },
      {
        body: {
          bundleProfile: "multiAssetReplacement",
          channel: "production",
          marker: "multi-assets-a-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "firstBundleId",
        stage: "deploy first multi-asset bundle",
      },
      {
        kind: "tap",
        stage: "install first multi-asset update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          assetPaths: [
            "assets/src/test/_fixture-multi-asset-a.bmp",
            "assets/src/test/_fixture-multi-asset-b.bmp",
            "assets/src/test/_fixture-multi-asset-c.bmp",
          ],
          bundleId: "$firstBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-bundle-assets-stored",
        stage: "assert first multi-assets stored",
      },
      {
        body: {
          bundleProfile: "multiAssetReplacement",
          channel: "production",
          marker: "multi-assets-b-detox",
          mode: "reset",
          safeBundleIds: ["$firstBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "secondBundleId",
        stage: "deploy second multi-asset bundle",
      },
      {
        kind: "tap",
        stage: "install second multi-asset update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          assetPaths: [
            "assets/src/test/_fixture-multi-asset-a.bmp",
            "assets/src/test/_fixture-multi-asset-b.bmp",
            "assets/src/test/_fixture-multi-asset-c.bmp",
          ],
          bundleId: "$secondBundleId",
          previousBundleId: "$firstBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-multiple-assets-replaced",
        stage: "assert multi-assets replaced",
      },
    ],
  },
  archiveToDiffScenario,
  {
    name: "bspatch-consecutive-diff-ota",
    wave: 2,
    steps: [
      {
        body: {
          channel: "production",
          marker: "diff-a-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "firstBundleId",
        stage: "deploy first diff bundle",
      },
      {
        body: {
          channel: "production",
          diffBaseBundleId: "$firstBundleId",
          marker: "diff-b-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: ["$firstBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "secondBundleId",
        stage: "deploy second diff bundle",
      },
      {
        body: {
          baseBundleId: "$firstBundleId",
          bundleId: "$secondBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-bsdiff-patch-applied",
        stage: "assert consecutive diff patch",
      },
    ],
  },
  {
    name: "bspatch-disabled-chain-rollback",
    wave: 2,
    steps: [
      {
        body: {
          channel: "production",
          marker: "chain-base-detox",
          mode: "reset",
          patchMaxBaseBundles: 2,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "baseBundleId",
        stage: "deploy chain base bundle",
      },
      {
        body: { bundleId: "$baseBundleId", enabled: false },
        kind: "control",
        pathName: "/e2e/jobs/patch-bundle",
        stage: "disable chain base bundle",
      },
      {
        body: { bundleId: "$baseBundleId" },
        kind: "control",
        pathName: "/e2e/assert-bundle-patch-bases",
        stage: "assert disabled chain bases",
      },
    ],
  },
  {
    name: "bspatch-manifest-diff-fallback",
    wave: 2,
    steps: [
      {
        body: {
          channel: "production",
          marker: "manifest-base-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "previousBundleId",
        stage: "deploy manifest base bundle",
      },
      {
        body: {
          channel: "production",
          marker: "manifest-fallback-detox",
          mode: "reset",
          safeBundleIds: ["$previousBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "bundleId",
        stage: "deploy manifest fallback bundle",
      },
      {
        body: {
          bundleId: "$bundleId",
          previousBundleId: "$previousBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-manifest-diff-applied",
        stage: "assert manifest diff fallback",
      },
    ],
  },
];
