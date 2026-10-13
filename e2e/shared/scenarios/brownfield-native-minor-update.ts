import type { ScenarioDefinition } from "./types.ts";

/**
 * Brownfield only: `HotUpdater.prepare` returns `pending` for an update that
 * is not required and downloads it in the background; the next start runs it
 * and reports `upToDate`.
 */
export const brownfieldNativeMinorUpdateScenario: ScenarioDefinition = {
  name: "brownfield-native-minor-update",
  run: async (app) => {
    await app.control(
      "deploy minor bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "native-minor-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "minorBundleId",
        saveResultFieldsAs: { releaseId: "minorReleaseId" },
      },
    );
    await app.control(
      "turn on the native update check",
      "/e2e/jobs/set-native-prepare",
      { strategy: "appVersion" },
      { saveResultFieldsAs: { nonce: "nativePrepareNonce" } },
    );
    await app.launch("launch with the native update check");
    await app.control(
      "wait native prepare pending",
      "/e2e/jobs/wait-for-native-prepare",
      { nonce: "$nativePrepareNonce", status: "pending" },
    );
    // React Native read the bundle as soon as prepare returned, so the
    // background download stages the update for the next start.
    await app.control(
      "wait minor bundle staged",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$minorBundleId",
        releaseId: "$minorReleaseId",
        verificationPending: true,
      },
    );
    await app.terminate("close the app");
    await app.launch("launch the staged update");
    await app.control(
      "wait native prepare up to date",
      "/e2e/jobs/wait-for-native-prepare",
      { nonce: "$nativePrepareNonce", status: "upToDate" },
    );
    await app.control(
      "wait minor bundle verified",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$minorBundleId",
        releaseId: "$minorReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert minor Bundle",
      "runtime-bundle-id",
      "$minorBundleId",
    );
    await app.assertText(
      "assert minor marker",
      "runtime-scenario-marker",
      "native-minor-detox",
    );
  },
};
