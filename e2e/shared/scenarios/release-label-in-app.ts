import type { ScenarioDefinition } from "./types.ts";

const MARKER = "release-label-second";

/**
 * The app shows the label of the release it runs: none on the built-in
 * bundle, still none while an update is only staged, the label the deploy
 * printed once the update runs, and the same label after a restart with the
 * update server unreachable. The expected label is the one `hot-updater
 * deploy` printed, which the app's path to it never reads.
 */
export const releaseLabelInAppScenario: ScenarioDefinition = {
  name: "release-label-in-app",
  run: async (app) => {
    await app.control("deploy an earlier release", "/e2e/jobs/deploy-bundle", {
      channel: "production",
      marker: "release-label-first",
      mode: "reset",
      safeBundleIds: [],
      targetAppVersion: "1.0.x",
    });
    await app.control(
      "deploy the release the app installs",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: MARKER,
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultFieldsAs: {
          label: "installedLabel",
          releaseId: "installedReleaseId",
        },
      },
    );

    await app.launch("launch the built-in bundle");
    await app.assertText(
      "the built-in bundle has no label",
      "runtime-release-label",
      "none",
      { exactText: true },
    );
    await app.tap(
      "install the release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "the release installs",
      "update-action-result",
      "current-channel -> installed ID $installedReleaseId",
      { exactText: true },
    );
    await app.assertText(
      "a staged release leaves the running bundle's label",
      "runtime-release-label",
      "none",
      { exactText: true },
    );

    // The staged release runs from the next launch.
    await app.terminate("quit the built-in bundle");
    await app.launch("launch the release");
    await app.assertText(
      "the release runs",
      "runtime-scenario-marker",
      MARKER,
      {
        exactText: true,
      },
    );
    await app.assertText(
      "the app shows the release's label",
      "runtime-release-label",
      "$installedLabel",
      { exactText: true },
    );

    // A launch that never finished rolls back, so the relaunch also shows
    // the release was kept.
    await app.terminate("quit the app");
    await app.control("the update server goes down", "/e2e/proxy-control", {
      reset: true,
      updateServerUnreachable: true,
    });
    await app.launch("launch again, offline");
    await app.assertText(
      "the release still runs",
      "runtime-scenario-marker",
      MARKER,
      { exactText: true },
    );
    await app.assertText(
      "its label reads the same after the restart, offline",
      "runtime-release-label",
      "$installedLabel",
      { exactText: true },
    );
  },
};
