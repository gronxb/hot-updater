import type { ScenarioDefinition } from "./types.ts";

/**
 * A Release whose stored platform bundle doesn't match its manifest hash is
 * refused, and the device remembers it: later launches check for updates as
 * usual but never fetch the bad file again, and the app keeps running the
 * bundle it had. Each launch tries the update, so without the memory every
 * launch would download the file once more.
 *
 * The proxy serves the bad bytes for every request of the platform bundle,
 * the same on every storage provider, and withholds the archive so the file
 * itself is downloaded.
 */
export const failedVerificationNotRedownloadedScenario: ScenarioDefinition = {
  name: "failed-verification-not-redownloaded",
  run: async (app) => {
    await app.control(
      "deploy a Release whose stored bundle is corrupt",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "failed-verification-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "corruptBundleId" },
    );
    await app.control(
      "serve the platform bundle with bytes that fail its hash",
      "/e2e/proxy-control",
      {
        archiveAvailable: false,
        corruptPlatformBundle: true,
        reset: true,
      },
    );

    await app.launch("first launch with the corrupt Release");
    await app.tap(
      "attempt the corrupt update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert the corrupt update was refused for its hash",
      "update-action-result",
      "signature verification failed",
    );
    await app.control(
      "assert the corrupt file was fetched",
      "/e2e/assert-proxy",
      { platformBundleRequests: 1 },
    );

    for (const launch of ["second", "third"]) {
      // The result shown survives a restart; clear it so this launch's check
      // is the one asserted.
      await app.control(
        `clear the shown result before the ${launch} launch`,
        "/e2e/screen-state",
        { updateActionResult: "idle" },
      );
      await app.reload(`${launch} launch with the corrupt Release`);
      await app.tap(
        `check for updates on the ${launch} launch`,
        "action-install-current-channel-update",
      );
      await app.assertText(
        `assert the ${launch} check finished`,
        "update-action-result",
        ["current-channel -> no-update", "current-channel -> error"],
      );
    }

    await app.control(
      "assert the corrupt file was fetched once over three launches",
      "/e2e/assert-proxy",
      // Each launch checked: the startup check and the tap.
      { minCatalogRequests: 6, platformBundleRequests: 1 },
    );
    await app.assertText(
      "assert the last check found no update",
      "update-action-result",
      "current-channel -> no-update",
      { exactText: true },
    );
    await app.assertText(
      "assert the built-in bundle still runs",
      "runtime-scenario-marker",
      "$initialMarker",
    );
  },
};
