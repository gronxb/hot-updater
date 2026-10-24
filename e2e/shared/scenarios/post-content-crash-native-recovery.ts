import type { ScenarioAppDriver, ScenarioDefinition } from "./types.ts";

/**
 * Runs a stable bundle, then a `crash-after-content` bundle that main
 * verifies at its first content and that crashes long after, once main's
 * launch monitoring has ended. Its own update check fails, so from here on a
 * fix reaches the device only through the native check of the next launch.
 */
export async function crashAfterFirstContent(
  app: ScenarioAppDriver,
  markers: { readonly crash: string; readonly stable: string },
) {
  await app.control(
    "capture post-content built-in bundle",
    "/e2e/capture-built-in-bundle-id",
    {},
    { saveResultAs: "postCrashBuiltInBundleId" },
  );
  await app.control(
    "deploy post-content stable",
    "/e2e/jobs/deploy-bundle",
    {
      channel: "production",
      marker: markers.stable,
      mode: "reset",
      safeBundleIds: [],
      targetAppVersion: "1.0.x",
    },
    {
      saveResultAs: "postCrashStableBundleId",
      saveResultFieldsAs: { releaseId: "postCrashStableReleaseId" },
    },
  );
  await app.launch("launch post-content stable installer");
  await app.tap(
    "install post-content stable",
    "action-install-current-channel-update",
  );
  await app.assertText(
    "assert post-content stable installed",
    "update-action-result",
    "current-channel -> installed ID $postCrashStableReleaseId",
    { exactText: true },
  );
  await app.control(
    "wait post-content stable pending",
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: "$postCrashStableBundleId",
      verificationPending: true,
    },
  );
  await app.reload("reload post-content stable");
  await app.control(
    "wait post-content stable active",
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: "$postCrashStableBundleId",
      verificationPending: false,
    },
  );

  await app.control(
    "deploy post-content crash",
    "/e2e/jobs/deploy-bundle",
    {
      channel: "production",
      marker: markers.crash,
      mode: "crash-after-content",
      safeBundleIds: ["$postCrashBuiltInBundleId", "$postCrashStableBundleId"],
      targetAppVersion: "1.0.x",
    },
    {
      saveResultAs: "postCrashBundleId",
      saveResultFieldsAs: { releaseId: "postCrashReleaseId" },
    },
  );
  await app.launch("refresh post-content crash update check");
  await app.tap(
    "install post-content crash",
    "action-install-current-channel-update",
  );
  await app.assertText(
    "assert post-content crash installed",
    "update-action-result",
    "current-channel -> installed ID $postCrashReleaseId",
    { exactText: true },
  );
  await app.control(
    "wait post-content crash pending",
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: "$postCrashBundleId",
      verificationPending: true,
    },
  );
  await app.launch("launch post-content crash bundle", { expectCrash: true });
  // Verified at its first content: the fatal that follows is past it.
  await app.control(
    "verify post-content crash first content",
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: "$postCrashBundleId",
      releaseId: "$postCrashReleaseId",
      verificationPending: false,
    },
  );
  await app.control(
    "wait post-content crash exit",
    "/e2e/jobs/wait-for-app-exit",
    { bundleId: "$postCrashBundleId" },
  );
  // A crash after the monitoring rolls nothing back.
  await app.control(
    "assert post-content crash still active",
    "/e2e/assert-metadata-active",
    { bundleId: "$postCrashBundleId" },
  );
}

export const postContentCrashNativeRecoveryScenario: ScenarioDefinition = {
  name: "post-content-crash-native-recovery",
  run: async (app) => {
    await crashAfterFirstContent(app, {
      crash: "post-content-crash-detox",
      stable: "post-content-stable-detox",
    });
    // An ordinary update: the crashing bundle's own check never reaches it,
    // and a startup check installs only a forced one.
    await app.control(
      "deploy post-content fix",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        forceUpdate: false,
        marker: "post-content-fix-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "postCrashFixBundleId",
        saveResultFieldsAs: { releaseId: "postCrashFixReleaseId" },
      },
    );
    await app.launch("relaunch post-content crash bundle after the fix", {
      expectCrash: true,
    });
    // The crash bundle keeps running until its fatal; the native check of
    // this launch stages the fix meanwhile.
    await app.control(
      "wait native check stages post-content fix",
      "/e2e/jobs/wait-for-metadata",
      {
        attempts: 240,
        bundleId: "$postCrashFixBundleId",
        releaseId: "$postCrashFixReleaseId",
        verificationPending: true,
      },
    );
    await app.control(
      "wait post-content crash exit after staging",
      "/e2e/jobs/wait-for-app-exit",
      { bundleId: "$postCrashBundleId" },
    );
    await app.launch("open the app with the staged post-content fix");
    await app.control(
      "verify post-content fix first content",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$postCrashFixBundleId",
        releaseId: "$postCrashFixReleaseId",
        verificationPending: false,
      },
    );
    await app.control(
      "assert post-content fix applied",
      "/e2e/assert-launch-report",
      {
        status: "UPDATE_APPLIED",
        fromBundleId: "$postCrashBundleId",
        toBundleId: "$postCrashFixBundleId",
        toReleaseId: "$postCrashFixReleaseId",
      },
    );
    await app.assertText(
      "post-content fix Bundle runs",
      "runtime-bundle-id",
      "$postCrashFixBundleId",
    );
    await app.assertText(
      "post-content fix Release runs",
      "runtime-release-state",
      "$postCrashFixReleaseId",
    );
    await app.assertText(
      "post-content fix marker runs",
      "runtime-scenario-marker",
      "post-content-fix-detox",
    );
    await app.control(
      "assert post-content fix active",
      "/e2e/assert-metadata-active",
      { bundleId: "$postCrashFixBundleId" },
    );
  },
};
