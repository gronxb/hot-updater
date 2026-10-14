import type { ScenarioDefinition } from "./types.ts";

/**
 * Brownfield only: the host's native update check reports `pending` for an
 * update that is not required and downloads it in the background; the next
 * start runs it and reports `upToDate`.
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
      "/e2e/jobs/set-native-check",
      // Long enough for the held artifact request below.
      { strategy: "appVersion", requestTimeoutMs: 120_000 },
      { saveResultFieldsAs: { nonce: "nativeCheckNonce" } },
    );
    // Hold the artifact until React Native runs, so the first launch reads
    // the current bundle and the background download stages the update.
    await app.control("hold the minor artifact", "/e2e/proxy-control", {
      holdArtifacts: true,
    });
    await app.launch("launch with the native update check");
    await app.control(
      "wait native check pending",
      "/e2e/jobs/wait-for-native-check",
      { nonce: "$nativeCheckNonce", status: "pending" },
    );
    await app.control("release the minor artifact", "/e2e/proxy-control", {
      holdArtifacts: false,
    });
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
      "wait native check up to date",
      "/e2e/jobs/wait-for-native-check",
      { nonce: "$nativeCheckNonce", status: "upToDate" },
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
