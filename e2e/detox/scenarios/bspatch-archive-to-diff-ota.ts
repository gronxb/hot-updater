import { installCurrentChannelUpdate } from "./install-actions.ts";
import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchArchiveToDiffOtaScenario: DetoxScenarioDefinition = {
  name: "bspatch-archive-to-diff-ota",
  run: async (app) => {
    await app.control(
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
    await app.launch("launch archive base app");
    await installCurrentChannelUpdate(app, "install archive base update");
    await app.control(
      "wait archive base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$archiveBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.control(
      "assert first ota uses archive",
      "/e2e/assert-first-ota-uses-archive",
      {
        bundleId: "$archiveBundleId",
      },
    );
    await app.reload("reload archive base update");
    await app.control(
      "wait archive base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$archiveBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert archive base bundle id",
      "runtime-bundle-id",
      "$archiveBundleId",
    );
    await app.assertText(
      "assert archive base marker",
      "runtime-scenario-marker",
      "archive-base-detox",
    );
    await app.assertText(
      "assert archive base stable launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.control(
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
    await app.control(
      "assert archive diff bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$diffBundleId",
        expectedBaseBundleIds: ["$archiveBundleId"],
      },
    );
    await app.launch("launch archive diff app");
    await installCurrentChannelUpdate(app, "install archive diff update");
    await app.control(
      "wait archive diff metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diffBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload archive diff update");
    await app.control(
      "wait archive diff metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diffBundleId",
        verificationPending: false,
      },
    );
    await app.control(
      "assert archive diff patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$archiveBundleId",
      },
    );
    await app.assertText(
      "assert archive diff bundle id",
      "runtime-bundle-id",
      "$diffBundleId",
    );
    await app.assertText(
      "assert archive diff marker",
      "runtime-scenario-marker",
      "archive-diff-detox",
    );
    await app.assertText(
      "assert archive diff stable launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
  },
};
