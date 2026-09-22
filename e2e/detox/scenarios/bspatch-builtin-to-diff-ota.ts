import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchBuiltinToDiffOtaScenario: DetoxScenarioDefinition = {
  name: "bspatch-builtin-to-diff-ota",
  run: async (app) => {
    await app.control(
      "deploy built-in base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "builtin-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "builtinBundleId",
        saveResultFieldsAs: {
          releaseId: "builtinReleaseId",
        },
      },
    );
    await app.control(
      "make optional archive unavailable for built-in reuse evidence",
      "/e2e/proxy-control",
      { archiveAvailable: false },
    );
    await app.launch("launch built-in base app");
    await app.tap(
      "install built-in base update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait built-in base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$builtinBundleId",
        verificationPending: true,
      },
    );
    await app.control(
      "assert first ota uses built-in manifest",
      "/e2e/assert-first-ota-uses-built-in-manifest",
      {
        bundleId: "$builtinBundleId",
      },
    );
    await app.control(
      "restore optional archive availability",
      "/e2e/proxy-control",
      { archiveAvailable: true },
    );
    await app.reload("reload built-in base update");
    await app.control(
      "wait built-in base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$builtinBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert built-in base bundle id",
      "runtime-bundle-id",
      "$builtinBundleId",
    );
    await app.assertText(
      "assert built-in base marker",
      "runtime-scenario-marker",
      "builtin-base-detox",
    );
    await app.assertText(
      "assert built-in base stable launch",
      "launch-status-result",
      [
        "Current Launch Status: UNCHANGED",
        "Current Launch Status: UPDATE_APPLIED",
      ],
    );
    await app.control(
      "deploy diff bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$builtinBundleId",
        marker: "builtin-diff-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$builtinBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "diffBundleId",
        saveResultFieldsAs: {
          releaseId: "diffReleaseId",
        },
      },
    );
    await app.control(
      "assert built-in diff bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$diffBundleId",
        expectedBaseBundleIds: ["$builtinBundleId"],
      },
    );
    await app.launch("launch built-in diff app");
    await app.tap(
      "install built-in diff update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait built-in diff metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diffBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload built-in diff update");
    await app.control(
      "wait built-in diff metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diffBundleId",
        verificationPending: false,
      },
    );
    await app.control(
      "assert built-in diff patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$builtinBundleId",
      },
    );
    await app.assertText(
      "assert built-in diff bundle id",
      "runtime-bundle-id",
      "$diffBundleId",
    );
    await app.assertText(
      "assert built-in diff marker",
      "runtime-scenario-marker",
      "builtin-diff-detox",
    );
    await app.assertText(
      "assert built-in diff stable launch",
      "launch-status-result",
      [
        "Current Launch Status: UNCHANGED",
        "Current Launch Status: UPDATE_APPLIED",
      ],
    );
  },
};
