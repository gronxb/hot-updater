import type { DetoxScenarioDefinition } from "./types.ts";

export const crashThenNextSafeUpdateScenario: DetoxScenarioDefinition = {
  name: "crash-then-next-safe-update",
  run: async (app) => {
    await app.control(
      "capture next-safe built-in Bundle",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "nextSafeBuiltInBundleId" },
    );
    await app.control(
      "deploy next-safe stable",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "next-safe-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "nextSafeStableBundleId",
        saveResultFieldsAs: { releaseId: "nextSafeStableReleaseId" },
      },
    );
    await app.launch("launch next-safe stable");
    await app.tap(
      "install next-safe stable",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait next-safe stable pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$nextSafeStableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload next-safe stable");
    await app.control(
      "wait next-safe stable active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$nextSafeStableBundleId",
        verificationPending: false,
      },
    );
    await app.control(
      "deploy next-safe crash",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "next-safe-crash-detox",
        mode: "crash",
        safeBundleIds: ["$nextSafeBuiltInBundleId", "$nextSafeStableBundleId"],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "nextSafeCrashBundleId" },
    );
    await app.launch("launch next-safe crash update");
    await app.tap(
      "install next-safe crash",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait next-safe crash pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$nextSafeCrashBundleId",
        recoveredStableBundleId: "$nextSafeStableBundleId",
        verificationPending: true,
      },
    );
    await app.launch("launch next-safe crash Bundle");
    await app.control(
      "wait next-safe recovery",
      "/e2e/wait-for-crash-recovery",
      {
        crashedBundleId: "$nextSafeCrashBundleId",
        stableBundleId: "$nextSafeStableBundleId",
      },
    );
    await app.control(
      "deploy next safe update",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "next-safe-update-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "nextSafeBundleId",
        saveResultFieldsAs: { releaseId: "nextSafeReleaseId" },
      },
    );
    await app.launch("launch next safe update");
    await app.tap(
      "install next safe update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait next safe update pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$nextSafeBundleId",
        releaseId: "$nextSafeReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload next safe update");
    await app.assertText(
      "assert next safe Bundle active",
      "runtime-bundle-id",
      "$nextSafeBundleId",
    );
    await app.assertText(
      "assert next safe Release active",
      "runtime-release-state",
      "$nextSafeReleaseId",
    );
    await app.control(
      "assert previous crash retained",
      "/e2e/assert-crash-history",
      { bundleId: "$nextSafeCrashBundleId" },
    );
  },
};
