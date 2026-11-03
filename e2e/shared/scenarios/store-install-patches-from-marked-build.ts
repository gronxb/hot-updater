import type { ScenarioDefinition } from "./types.ts";

/** The version the example's native projects build: the exact app version a native build registers. */
const APP_VERSION = "1.0";
const MARKER = "store-mark-patch-detox";

/**
 * A team tests a newer build on the channel of the build the store sells. The
 * store build S is what this device installs. T is a real, newer binary in the
 * same scope, registered after S, and never installed here. Marking S has to
 * make the next deploy patch from S, so a fresh S install's first OTA is a
 * patch. Without the mark's effect the deploy patches from T, and S downloads
 * the whole file.
 *
 * Every expectation comes from the app's rendered output and the update
 * server's request log, and the two builds' IDs from their compiled code. Once
 * the OTA is deployed the checks all run, so a failure names every symptom,
 * then throws.
 */
export const storeInstallPatchesFromMarkedBuildScenario: ScenarioDefinition = {
  name: "store-install-patches-from-marked-build",
  run: async (app) => {
    await app.control(
      "read both builds' IDs from their code",
      "/e2e/jobs/read-native-builds",
      {},
      {
        saveResultFieldsAs: {
          runBuildMinBundleId: "storeBuildMinBundleId",
          otherBuildMinBundleId: "newerBuildMinBundleId",
        },
      },
    );
    await app.control(
      "register the store build",
      "/e2e/jobs/register-native-build",
      { appVersion: APP_VERSION },
      {
        saveResultFieldsAs: {
          nativeBuildChannel: "storeBuildChannel",
          nativeBuildId: "storeBuildId",
        },
      },
    );
    await app.control(
      "register a newer build on the store build's channel",
      "/e2e/jobs/register-native-build",
      {
        appVersion: APP_VERSION,
        build: "other",
        channel: "$storeBuildChannel",
      },
    );
    await app.control("mark the store build", "/e2e/jobs/mark-native-build", {
      id: "$storeBuildId",
    });
    await app.control(
      "deploy the first update",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "$storeBuildChannel",
        marker: MARKER,
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: [],
        targetAppVersion: APP_VERSION,
      },
      {
        saveResultAs: "otaBundleId",
        saveResultFieldsAs: { releaseId: "otaReleaseId" },
      },
    );

    await app.launch("launch the fresh store install");
    await app.assertText(
      "the store install runs its built-in bundle",
      "runtime-reported-bundle-id",
      "$storeBuildMinBundleId",
      { exactText: true },
    );
    await app.typeText(
      "enter the store build's channel",
      "runtime-channel-input",
      "$storeBuildChannel",
    );
    await app.tap(
      "install the first update",
      "action-install-runtime-channel-update",
    );

    const failures: string[] = [];
    const check = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    };
    await check(() =>
      app.assertText(
        "the app installs the first update",
        "update-action-result",
        "runtime-channel:$storeBuildChannel -> installed ID $otaReleaseId",
        { exactText: true },
      ),
    );
    await check(() =>
      app.control(
        "the server log shows only a patch downloaded",
        "/e2e/assert-bundle-artifact-transfers",
        {
          archiveRequests: 0,
          currentBundleId: "$storeBuildMinBundleId",
          fileRequests: 0,
          patchRequests: 1,
          targetBundleId: "$otaBundleId",
        },
      ),
    );
    // A launch failure stops the scenario here: only checks are collected.
    await app.reload("run the first update");
    await check(() =>
      app.assertText(
        "the first update runs",
        "runtime-scenario-marker",
        MARKER,
        { exactText: true },
      ),
    );
    if (failures.length > 0) {
      throw new Error(
        `The store install's first update wasn't a patch from the marked build:\n${failures.join("\n")}`,
      );
    }
  },
};
