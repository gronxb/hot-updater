import type { DetoxScenarioDefinition } from "./types.ts";

export const wave2Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "multi-asset-replacement",
    stages: [
      "launch built-in app",
      "deploy first multi-asset bundle",
      "install first multi-asset update",
      "wait first multi-asset metadata pending",
      "reload first multi-asset update",
      "wait first multi-asset metadata stable",
      "assert first multi-assets stored",
      "deploy second multi-asset bundle",
      "install second multi-asset update",
      "wait second multi-asset metadata pending",
      "reload second multi-asset update",
      "wait second multi-asset metadata stable",
      "assert multi-assets replaced",
    ],
    wave: 2,
    run: async (scenario) => {
      await scenario.launch("launch built-in app");
      await scenario.control(
        "deploy first multi-asset bundle",
        "/e2e/jobs/deploy-bundle",
        {
          bundleProfile: "multiAssetReplacement",
          channel: "production",
          marker: "multi-assets-a-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "firstBundleId",
        },
      );
      await scenario.tap(
        "install first multi-asset update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait first multi-asset metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$firstBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload first multi-asset update");
      await scenario.control(
        "wait first multi-asset metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$firstBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert first multi-assets stored",
        "/e2e/assert-bundle-assets-stored",
        {
          assetPaths: [
            "assets/src/test/_fixture-multi-asset-a.bmp",
            "assets/src/test/_fixture-multi-asset-b.bmp",
            "assets/src/test/_fixture-multi-asset-c.bmp",
          ],
          bundleId: "$firstBundleId",
        },
      );
      await scenario.control(
        "deploy second multi-asset bundle",
        "/e2e/jobs/deploy-bundle",
        {
          bundleProfile: "multiAssetReplacement",
          channel: "production",
          marker: "multi-assets-b-detox",
          mode: "reset",
          safeBundleIds: ["$firstBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "secondBundleId",
        },
      );
      await scenario.tap(
        "install second multi-asset update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait second multi-asset metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$secondBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload second multi-asset update");
      await scenario.control(
        "wait second multi-asset metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$secondBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert multi-assets replaced",
        "/e2e/assert-multiple-assets-replaced",
        {
          assetPaths: [
            "assets/src/test/_fixture-multi-asset-a.bmp",
            "assets/src/test/_fixture-multi-asset-b.bmp",
            "assets/src/test/_fixture-multi-asset-c.bmp",
          ],
          bundleId: "$secondBundleId",
          previousBundleId: "$firstBundleId",
        },
      );
    },
  },
  {
    name: "bspatch-archive-to-diff-ota",
    stages: [
      "deploy archive base bundle",
      "launch archive base app",
      "install archive base update",
      "wait archive base metadata pending",
      "assert first ota uses archive",
      "reload archive base update",
      "wait archive base metadata stable",
      "assert archive base bundle id",
      "assert archive base marker",
      "assert archive base stable launch",
      "deploy diff bundle",
      "assert archive diff bases",
      "launch archive diff app",
      "install archive diff update",
      "wait archive diff metadata pending",
      "reload archive diff update",
      "wait archive diff metadata stable",
      "assert archive diff patch",
      "assert archive diff bundle id",
      "assert archive diff marker",
      "assert archive diff stable launch",
    ],
    wave: 2,
    run: async (scenario) => {
      await scenario.control(
        "deploy archive base bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "archive-base-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "archiveBundleId",
        },
      );
      await scenario.launch("launch archive base app");
      await scenario.tap(
        "install archive base update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait archive base metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$archiveBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.control(
        "assert first ota uses archive",
        "/e2e/assert-first-ota-uses-archive",
        {
          bundleId: "$archiveBundleId",
        },
      );
      await scenario.reload("reload archive base update");
      await scenario.control(
        "wait archive base metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$archiveBundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert archive base bundle id",
        "runtime-bundle-id",
        "$archiveBundleId",
      );
      await scenario.assertText(
        "assert archive base marker",
        "runtime-scenario-marker",
        "archive-base-detox",
      );
      await scenario.assertText(
        "assert archive base stable launch",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
      await scenario.control(
        "deploy diff bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          diffBaseBundleId: "$archiveBundleId",
          marker: "archive-diff-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: ["$archiveBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "diffBundleId",
        },
      );
      await scenario.control(
        "assert archive diff bases",
        "/e2e/assert-bundle-patch-bases",
        {
          bundleId: "$diffBundleId",
          expectedBaseBundleIds: ["$archiveBundleId"],
        },
      );
      await scenario.launch("launch archive diff app");
      await scenario.tap(
        "install archive diff update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait archive diff metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$diffBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload archive diff update");
      await scenario.control(
        "wait archive diff metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$diffBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert archive diff patch",
        "/e2e/assert-bsdiff-patch-applied",
        {
          assetPath: "$diffPatchAssetPath",
          baseBundleId: "$archiveBundleId",
        },
      );
      await scenario.assertText(
        "assert archive diff bundle id",
        "runtime-bundle-id",
        "$diffBundleId",
      );
      await scenario.assertText(
        "assert archive diff marker",
        "runtime-scenario-marker",
        "archive-diff-detox",
      );
      await scenario.assertText(
        "assert archive diff stable launch",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
    },
  },
  {
    name: "bspatch-consecutive-diff-ota",
    stages: [
      "deploy first diff bundle",
      "install first diff bundle",
      "wait first diff metadata pending",
      "reload first diff bundle",
      "wait first diff metadata stable",
      "deploy second diff bundle",
      "install second diff bundle",
      "wait second diff metadata pending",
      "reload second diff bundle",
      "wait second diff metadata stable",
      "assert consecutive diff patch",
    ],
    wave: 2,
    run: async (scenario) => {
      await scenario.control(
        "deploy first diff bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "diff-a-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "firstBundleId",
        },
      );
      await scenario.tap(
        "install first diff bundle",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait first diff metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$firstBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload first diff bundle");
      await scenario.control(
        "wait first diff metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$firstBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "deploy second diff bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          diffBaseBundleId: "$firstBundleId",
          marker: "diff-b-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: ["$firstBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "secondBundleId",
        },
      );
      await scenario.tap(
        "install second diff bundle",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait second diff metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$secondBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload second diff bundle");
      await scenario.control(
        "wait second diff metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$secondBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert consecutive diff patch",
        "/e2e/assert-bsdiff-patch-applied",
        {
          assetPath: "$diffPatchAssetPath",
          baseBundleId: "$firstBundleId",
          bundleId: "$secondBundleId",
        },
      );
    },
  },
  {
    name: "bspatch-disabled-chain-rollback",
    stages: [
      "deploy chain base bundle",
      "disable chain base bundle",
      "assert disabled chain bases",
    ],
    wave: 2,
    run: async (scenario) => {
      await scenario.control(
        "deploy chain base bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "chain-base-detox",
          mode: "reset",
          patchMaxBaseBundles: 2,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "baseBundleId",
        },
      );
      await scenario.control(
        "disable chain base bundle",
        "/e2e/jobs/patch-bundle",
        {
          bundleId: "$baseBundleId",
          enabled: false,
        },
      );
      await scenario.control(
        "assert disabled chain bases",
        "/e2e/assert-bundle-patch-bases",
        {
          bundleId: "$baseBundleId",
        },
      );
    },
  },
  {
    name: "bspatch-manifest-diff-fallback",
    stages: [
      "deploy manifest base bundle",
      "launch manifest base app",
      "install manifest base update",
      "wait manifest base metadata pending",
      "reload manifest base update",
      "wait manifest base metadata stable",
      "deploy manifest intermediate bundle",
      "deploy manifest fallback bundle",
      "assert manifest fallback patch bases",
      "launch manifest fallback app",
      "install manifest fallback update",
      "wait manifest fallback metadata pending",
      "reload manifest fallback update",
      "wait manifest fallback metadata stable",
      "assert manifest diff fallback",
    ],
    wave: 2,
    run: async (scenario) => {
      await scenario.control(
        "deploy manifest base bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "manifest-base-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "previousBundleId",
        },
      );
      await scenario.launch("launch manifest base app");
      await scenario.tap(
        "install manifest base update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait manifest base metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload manifest base update");
      await scenario.control(
        "wait manifest base metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "deploy manifest intermediate bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "manifest-intermediate-detox",
          mode: "reset",
          safeBundleIds: ["$previousBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "intermediateBundleId",
        },
      );
      await scenario.control(
        "deploy manifest fallback bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "manifest-fallback-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: ["$previousBundleId", "$intermediateBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "bundleId",
        },
      );
      await scenario.control(
        "assert manifest fallback patch bases",
        "/e2e/assert-bundle-patch-bases",
        {
          absentBaseBundleIds: ["$previousBundleId"],
          bundleId: "$bundleId",
          expectedBaseBundleIds: ["$intermediateBundleId"],
        },
      );
      await scenario.launch("launch manifest fallback app");
      await scenario.tap(
        "install manifest fallback update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait manifest fallback metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload manifest fallback update");
      await scenario.control(
        "wait manifest fallback metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert manifest diff fallback",
        "/e2e/assert-manifest-diff-applied",
        {
          bundleId: "$bundleId",
          previousBundleId: "$previousBundleId",
        },
      );
    },
  },
];
