import type { ScenarioDefinition } from "./types.ts";

const MARKER = "going-back-ota-detox";

/**
 * The path a user takes: build A runs an OTA, another build of the app runs
 * without reaching the server, so it never writes its own update state, and A
 * is installed again. That other build's key change deleted the OTA, so A runs
 * its built-in bundle and has to download the OTA again.
 *
 * Every expectation comes from the app's rendered output and the update
 * server's request log, and the two builds' IDs from their compiled code. After
 * A is back the checks all run, so a failure names every symptom, then throw.
 */
export const otaAfterGoingBackToABuildScenario: ScenarioDefinition = {
  name: "ota-after-going-back-to-a-build",
  run: async (app) => {
    await app.control(
      "read both builds' IDs from their code",
      "/e2e/jobs/read-native-builds",
      {},
      {
        saveResultFieldsAs: {
          runBuildMinBundleId: "runBuildMinBundleId",
          otherBuildMinBundleId: "otherBuildMinBundleId",
        },
      },
    );
    await app.control(
      "deploy the OTA",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: MARKER,
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "otaBundleId",
        saveResultFieldsAs: { releaseId: "otaReleaseId" },
      },
    );

    // Build A runs the OTA.
    await app.launch("launch build A");
    await app.assertText(
      "build A starts on its built-in bundle",
      "runtime-reported-bundle-id",
      "$runBuildMinBundleId",
      { exactText: true },
    );
    await app.tap("install the OTA", "action-install-current-channel-update");
    await app.assertText(
      "the OTA installs",
      "update-action-result",
      "current-channel -> installed ID $otaReleaseId",
      { exactText: true },
    );
    await app.reload("run the OTA");
    await app.assertText("the OTA runs", "runtime-scenario-marker", MARKER, {
      exactText: true,
    });
    // A launch that never finished rolls back, so a second launch of the OTA
    // shows the first one was verified.
    await app.terminate("quit the OTA");
    await app.launch("launch the OTA again");
    await app.assertText(
      "the OTA still runs",
      "runtime-scenario-marker",
      MARKER,
      { exactText: true },
    );
    await app.terminate("leave build A");

    // Another build runs and can't reach the server.
    await app.control("the update server goes down", "/e2e/proxy-control", {
      reset: true,
      updateServerUnreachable: true,
    });
    await app.control(
      "install the other build",
      "/e2e/jobs/install-native-build",
      { build: "other" },
    );
    await app.launch("launch the other build");
    await app.assertText(
      "the other build runs",
      "runtime-reported-bundle-id",
      "$otherBuildMinBundleId",
      { exactText: true },
    );
    await app.tap(
      "the other build checks for an update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "the check gets no answer",
      "update-action-result",
      "current-channel -> no-update",
      { exactText: true },
    );
    await app.control("the check did try the server", "/e2e/assert-proxy", {
      artifactRequests: 0,
      minCatalogRequests: 1,
    });
    await app.terminate("leave the other build");

    // Build A again, with the server back.
    await app.control("the update server comes back", "/e2e/proxy-control", {
      reset: true,
      updateServerUnreachable: false,
    });
    await app.control(
      "install build A again",
      "/e2e/jobs/install-native-build",
      { build: "run" },
    );

    const failures: string[] = [];
    const check = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    };
    // A launch failure stops the scenario here: only checks are collected.
    await app.launch("launch build A again");
    await check(() =>
      app.assertText(
        "build A reports its built-in bundle",
        "runtime-reported-bundle-id",
        "$runBuildMinBundleId",
        { exactText: true },
      ),
    );
    await app.tap(
      "check for the OTA again",
      "action-install-current-channel-update",
    );
    await check(() =>
      app.assertText(
        "the check installs the OTA",
        "update-action-result",
        "current-channel -> installed ID $otaReleaseId",
        { exactText: true },
      ),
    );
    await check(() =>
      app.control(
        "the server log shows the OTA downloaded",
        "/e2e/assert-proxy",
        {
          minArtifactRequests: 1,
          minCatalogRequests: 1,
          minDownloadedBytes: 1,
        },
      ),
    );
    await app.terminate("quit build A");
    await app.launch("launch build A once more");
    await check(() =>
      app.assertText(
        "the next launch runs the OTA",
        "runtime-scenario-marker",
        MARKER,
        { exactText: true },
      ),
    );
    if (failures.length > 0) {
      // Already failed: say whether the device can still get the OTA at all.
      await app.tap("check once more", "action-install-current-channel-update");
      await check(() =>
        app.assertText(
          "a stuck device is still offered the OTA",
          "update-action-result",
          [
            "current-channel -> installed ID $otaReleaseId",
            "current-channel -> adopted ID $otaReleaseId",
          ],
        ),
      );
      throw new Error(
        `Going back to the build lost the OTA:\n${failures.join("\n")}`,
      );
    }
  },
};
