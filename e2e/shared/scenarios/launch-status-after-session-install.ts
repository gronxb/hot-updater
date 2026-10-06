import type { ScenarioDefinition } from "./types.ts";

// A bundle installed during a session waits for the next launch. Reading this
// session's launch again, as a root that initializes Hot Updater when it mounts
// does (HotUpdater.wrap after its activity is recreated), must settle instead
// of waiting for that bundle.
export const launchStatusAfterSessionInstallScenario: ScenarioDefinition = {
  name: "launch-status-after-session-install",
  run: async (app) => {
    await app.control(
      "deploy session-install bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "session-install-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "sessionInstallBundleId",
        saveResultFieldsAs: { releaseId: "sessionInstallReleaseId" },
      },
    );
    await app.launch("launch the built-in bundle");
    await app.assertText(
      "the built-in launch is unchanged",
      "launch-status-result",
      "Current Launch Status: UNCHANGED",
      { exactText: true },
    );
    await app.tap(
      "install the bundle during the session",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert the bundle installed",
      "update-action-result",
      "current-channel -> installed ID $sessionInstallReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait for the installed bundle",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sessionInstallBundleId",
        verificationPending: true,
      },
    );
    await app.tap(
      "initialize Hot Updater again in the session",
      "action-reinitialize-hot-updater",
    );
    await app.assertText(
      "the session's launch stays unchanged",
      "launch-status-result",
      "Current Launch Status: UNCHANGED",
      { exactText: true },
    );

    await app.terminate("stop the session that installed the bundle");
    await app.launch("open the app with the installed bundle");
    await app.control(
      "verify the installed bundle's first render",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sessionInstallBundleId",
        releaseId: "$sessionInstallReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "the next launch applies the bundle",
      "launch-status-result",
      "Current Launch Status: UPDATE_APPLIED",
      { exactText: true },
    );
    await app.control(
      "assert the next launch's report",
      "/e2e/assert-launch-report",
      {
        status: "UPDATE_APPLIED",
        toBundleId: "$sessionInstallBundleId",
        toReleaseId: "$sessionInstallReleaseId",
      },
    );
  },
};
