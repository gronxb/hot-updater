import type { ScenarioDefinition } from "./types.ts";

// Every link the proxy hands the app stays valid this long, as a presigned
// storage URL does. The app must request each one before then.
const LINK_LIFETIME_MS = 20_000;
// On Android each download takes this long, so it still runs when the cached
// apps freezer would freeze the app, about 10 s after it becomes cached.
const ANDROID_DOWNLOAD_DURATION_MS = 20_000;

export const downloadBeforeLinkExpiryScenario: ScenarioDefinition = {
  name: "download-before-link-expiry",
  run: async (app) => {
    await app.control(
      "deploy link expiry Release",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "link-expiry-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "linkExpiryBundleId",
        saveResultFieldsAs: { releaseId: "linkExpiryReleaseId" },
      },
    );
    await app.launch("launch link expiry app");
    await app.tap(
      "capture link expiry update",
      "action-capture-current-channel-update",
    );
    await app.assertText(
      "assert link expiry update captured",
      "update-action-result",
      "captured-update -> Release $linkExpiryReleaseId",
      { exactText: true },
    );
    // On iOS the manifest answers after iOS has suspended an app that left
    // the foreground, about a second after it leaves, so the update's next
    // download starts while the app is in the background. Android runs no
    // JavaScript timer while the app is in the background, and freezes the
    // app about 10 s after it becomes cached, so its downloads take longer
    // than that.
    await app.control("expire links", "/e2e/proxy-control", {
      linkLifetimeMs: LINK_LIFETIME_MS,
      ...(app.platform === "ios"
        ? { manifestDelayMs: 5_000 }
        : { downloadDurationMs: ANDROID_DOWNLOAD_DURATION_MS }),
      reset: true,
    });
    await app.tap(
      "apply the update once the app leaves the foreground",
      "action-apply-captured-update-in-background",
    );
    await app.background("leave the app as the download starts");
    if (app.platform === "android") {
      // Android keeps the app the user left last out of its cache. Another
      // app takes that place, so the app becomes cached as when the user
      // goes on to use other apps.
      await app.control(
        "open another app over the updating app",
        "/e2e/open-another-app",
      );
    }
    // The app stays in the background until every link it got has expired,
    // so the update installs only if each request went out in time.
    await app.control(
      "wait in the background until the links expire",
      "/e2e/jobs/wait-for-link-expiry",
    );
    if (app.platform === "android") {
      await app.control(
        "read the app process in the background",
        "/e2e/app-process-state",
      );
      // The update installs while the app is still in the background, not
      // once the user comes back to it. No relaunch, which would bring the
      // app back.
      await app.control(
        "wait for the install in the background",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$linkExpiryBundleId",
          relaunchLimit: 0,
          releaseId: "$linkExpiryReleaseId",
          verificationPending: true,
        },
      );
    }
    await app.assertText(
      "assert link expiry Release installed",
      "update-action-result",
      "captured-update -> installed Release $linkExpiryReleaseId",
    );
    await app.control(
      "wait link expiry metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$linkExpiryBundleId",
        releaseId: "$linkExpiryReleaseId",
        verificationPending: true,
      },
    );
  },
};
