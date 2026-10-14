import type { ScenarioDefinition } from "./types.ts";

/**
 * Brownfield only: `HotUpdater.prepare` stages a required update before React
 * Native starts, so the first React Native screen runs it with no JavaScript
 * install or reload.
 */
export const brownfieldNativeRequiredUpdateScenario: ScenarioDefinition = {
  name: "brownfield-native-required-update",
  run: async (app) => {
    await app.control(
      "deploy required bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        forceUpdate: true,
        marker: "native-required-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "requiredBundleId",
        saveResultFieldsAs: { releaseId: "requiredReleaseId" },
      },
    );
    await app.control(
      "turn on the native update check",
      "/e2e/jobs/set-native-prepare",
      // A slow provider must not turn the required update pending: the
      // requests and the wait get room beyond the hosts' defaults, while the
      // wait stays within the launch's 60-second screen-state wait, since
      // React Native starts only after it.
      {
        strategy: "appVersion",
        requestTimeoutMs: 20_000,
        prepareTimeoutMs: 45_000,
      },
      { saveResultFieldsAs: { nonce: "nativePrepareNonce" } },
    );
    await app.launch("launch with the native update check");
    await app.control(
      "wait native prepare ready",
      "/e2e/jobs/wait-for-native-prepare",
      { nonce: "$nativePrepareNonce", status: "ready" },
    );
    await app.control(
      "wait required bundle verified",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$requiredBundleId",
        releaseId: "$requiredReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert required Bundle on the first launch",
      "runtime-bundle-id",
      "$requiredBundleId",
    );
    await app.assertText(
      "assert required Release",
      "runtime-release-state",
      "$requiredReleaseId",
    );
    await app.assertText(
      "assert required marker",
      "runtime-scenario-marker",
      "native-required-detox",
    );
  },
};
