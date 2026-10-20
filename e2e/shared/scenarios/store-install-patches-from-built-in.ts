import type { ScenarioAppDriver, ScenarioDefinition } from "./types.ts";

/** The version the example's native projects build: the exact app version a native build registers. */
const NATIVE_BUILD_APP_VERSION = "1.0";

/**
 * Registers the installed app as a native build, deploys an update to the
 * build's own channel, and installs it from a fresh install: the store
 * install's first OTA.
 */
export async function installFirstOtaOfNativeBuild(
  app: ScenarioAppDriver,
  input: {
    readonly marker: string;
    /** Run after the deploy: what the server holds when the device asks. */
    readonly beforeInstall?: () => Promise<void>;
  },
) {
  await app.control(
    "register the installed native build",
    "/e2e/jobs/register-native-build",
    { appVersion: NATIVE_BUILD_APP_VERSION },
  );
  await app.control(
    "deploy the native build's first update",
    "/e2e/jobs/deploy-bundle",
    {
      channel: "$nativeBuildChannel",
      diffBaseBundleId: "$nativeBuildMinBundleId",
      marker: input.marker,
      mode: "reset",
      patchMaxBaseBundles: 1,
      safeBundleIds: [],
      targetAppVersion: NATIVE_BUILD_APP_VERSION,
    },
    {
      saveResultAs: "firstOtaBundleId",
      saveResultFieldsAs: { releaseId: "firstOtaReleaseId" },
    },
  );
  await app.control(
    "assert the built-in bundle is the patch base",
    "/e2e/assert-bundle-patch-bases",
    {
      bundleId: "$firstOtaBundleId",
      expectedBaseBundleIds: ["$nativeBuildMinBundleId"],
    },
  );
  await input.beforeInstall?.();
  await app.launch("launch the fresh install");
  await app.typeText(
    "enter the native build's channel",
    "runtime-channel-input",
    "$nativeBuildChannel",
  );
  await app.tap(
    "install the first update",
    "action-install-runtime-channel-update",
  );
  await app.assertText(
    "assert the first update installed",
    "update-action-result",
    "runtime-channel:$nativeBuildChannel -> installed ID $firstOtaReleaseId",
    { exactText: true },
  );
  await app.control(
    "wait first update metadata pending",
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: "$firstOtaBundleId",
      verificationPending: true,
    },
  );
  await app.reload("reload the first update");
  await app.control(
    "wait first update metadata stable",
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: "$firstOtaBundleId",
      verificationPending: false,
    },
  );
}

/** Asserts the first update runs, then empties the native build's channel. */
export async function assertFirstOtaRuns(
  app: ScenarioAppDriver,
  marker: string,
) {
  await app.assertText(
    "assert first update bundle id",
    "runtime-bundle-id",
    "$firstOtaBundleId",
  );
  await app.assertText(
    "assert first update marker",
    "runtime-scenario-marker",
    marker,
  );
  await app.control(
    "reset the native build's channel",
    "/e2e/jobs/reset-native-build-channel",
    { channel: "$nativeBuildChannel" },
  );
}

export const storeInstallPatchesFromBuiltInScenario: ScenarioDefinition = {
  name: "store-install-patches-from-built-in",
  run: async (app) => {
    const marker = "store-install-patch-detox";
    await installFirstOtaOfNativeBuild(app, { marker });
    // The patch applied to the installed app's own built-in bundle, so the
    // bytes the build registered are the bytes the device has.
    await app.control(
      "assert the built-in bundle was patched",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$nativeBuildMinBundleId",
      },
    );
    await app.control(
      "assert only the patch was downloaded",
      "/e2e/assert-bundle-artifact-transfers",
      {
        archiveRequests: 0,
        currentBundleId: "$nativeBuildMinBundleId",
        fileRequests: 0,
        patchRequests: 1,
        targetBundleId: "$firstOtaBundleId",
      },
    );
    await assertFirstOtaRuns(app, marker);
  },
};
