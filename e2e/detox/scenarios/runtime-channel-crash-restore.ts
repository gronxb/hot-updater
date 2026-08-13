import type { DetoxScenarioDefinition } from "./types.ts";

export const runtimeChannelCrashRestoreScenario: DetoxScenarioDefinition = {
  name: "runtime-channel-crash-restore",
  run: async (app) => {
    await app.control(
      "capture channel-crash built-in Bundle",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "channelCrashBuiltInBundleId" },
    );
    await app.control(
      "deploy beta stable",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "beta",
        marker: "channel-crash-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "channelCrashStableBundleId",
        saveResultFieldsAs: { releaseId: "channelCrashStableReleaseId" },
      },
    );
    await app.launch("launch channel-crash app");
    await app.tap(
      "install beta stable",
      "action-install-runtime-channel-update",
    );
    await app.control(
      "wait beta stable pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$channelCrashStableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload beta stable");
    await app.control(
      "wait beta stable active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$channelCrashStableBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert beta channel active",
      "runtime-current-channel",
      "beta",
    );
    await app.control(
      "deploy beta crash",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "beta",
        marker: "channel-crash-bundle-detox",
        mode: "crash",
        safeBundleIds: [
          "$channelCrashBuiltInBundleId",
          "$channelCrashStableBundleId",
        ],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "channelCrashBundleId" },
    );
    await app.launch("launch beta crash update");
    await app.tap(
      "install beta crash",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait beta crash pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$channelCrashBundleId",
        recoveredStableBundleId: "$channelCrashStableBundleId",
        verificationPending: true,
      },
    );
    await app.launch("launch beta crash Bundle");
    await app.control(
      "wait beta crash recovery",
      "/e2e/wait-for-crash-recovery",
      {
        crashedBundleId: "$channelCrashBundleId",
        stableBundleId: "$channelCrashStableBundleId",
      },
    );
    await app.assertText(
      "assert restored beta Bundle",
      "runtime-bundle-id",
      "$channelCrashStableBundleId",
    );
    await app.assertText(
      "assert restored beta Release",
      "runtime-release-state",
      "$channelCrashStableReleaseId",
    );
    await app.assertText(
      "assert restored beta channel",
      "runtime-current-channel",
      "beta",
    );
    await app.assertText(
      "assert restored channel remains switched",
      "runtime-channel-switched",
      "true",
    );
  },
};
