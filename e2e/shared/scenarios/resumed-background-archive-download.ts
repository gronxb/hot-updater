import type { ScenarioDefinition } from "./types.ts";

export const resumedBackgroundArchiveDownloadScenario: ScenarioDefinition = {
  name: "resumed-background-archive-download",
  run: async (app) => {
    await app.control(
      "deploy resumed archive base Release",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "resumed-archive-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "resumedArchiveBaseBundleId",
        saveResultFieldsAs: { releaseId: "resumedArchiveBaseReleaseId" },
      },
    );
    await app.launch("launch resumed archive base app");
    await app.tap(
      "install resumed archive base update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert resumed archive base Release installed",
      "update-action-result",
      "current-channel -> installed ID $resumedArchiveBaseReleaseId",
      { exactText: true },
    );
    await app.reload("reload resumed archive base update");
    await app.control(
      "wait resumed archive base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$resumedArchiveBaseBundleId",
        releaseId: "$resumedArchiveBaseReleaseId",
        verificationPending: false,
      },
    );

    // The large asset and the bundle make at least two changed files, so the
    // archive is downloaded.
    await app.control(
      "deploy resumed archive Release",
      "/e2e/jobs/deploy-bundle",
      {
        bundleProfile: "sizeAwareLargeDiff",
        channel: "production",
        marker: "resumed-archive-detox",
        mode: "reset",
        safeBundleIds: ["$resumedArchiveBaseBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "resumedArchiveBundleId",
        saveResultFieldsAs: { releaseId: "resumedArchiveReleaseId" },
      },
    );
    await app.launch("launch resumed archive app");
    await app.tap(
      "capture resumed archive update",
      "action-capture-current-channel-update",
    );
    await app.assertText(
      "assert resumed archive update captured",
      "update-action-result",
      "captured-update -> Release $resumedArchiveReleaseId",
      { exactText: true },
    );
    // A network change drops the archive download halfway, once.
    await app.control(
      "interrupt the archive download once",
      "/e2e/proxy-control",
      {
        archiveFailureMode: "interrupt",
        archiveFailures: 1,
        reset: true,
      },
    );
    await app.tap(
      "apply the update once the app leaves the foreground",
      "action-apply-captured-update-in-background",
    );
    // iOS downloads in its background URLSession while the app is inactive
    // or in the background.
    await app.background("send the app to the background");
    if (app.platform === "ios") {
      // The app comes back only after the proxy served the resumed archive,
      // so the download ran in the background session. Android has no such
      // session, and its install goes on once the app is back.
      await app.control(
        "wait for the resumed archive while in the background",
        "/e2e/jobs/wait-for-archive-resume",
      );
    }
    await app.assertText(
      "assert resumed archive Release installed",
      "update-action-result",
      "captured-update -> installed Release $resumedArchiveReleaseId",
    );
    await app.control(
      "assert interrupted archive transfer",
      "/e2e/assert-bundle-artifact-transfers",
      {
        archiveInterruptions: 1,
        currentBundleId: "$resumedArchiveBaseBundleId",
        targetBundleId: "$resumedArchiveBundleId",
        verifyAllAssetHashes: true,
        ...(app.platform === "ios"
          ? {
              // The background URLSession resumes the download with a Range
              // request and keeps the whole archive.
              archiveRequests: 2,
              archiveResumes: 1,
              fileRequests: 0,
              patchRequests: 0,
            }
          : {
              // Android's download fails, so each asset the two manifests
              // differ in is downloaded once, one by one: a patch of the
              // bundle, the large asset as a file, and raw/keep.xml as a file
              // when the bundler emits one.
              archiveRequests: 1,
              archiveResumes: 0,
              fileRequests: "changed-assets",
              maxRequestsPerAsset: 1,
              patchRequests: 1,
            }),
      },
    );
    await app.control(
      "wait resumed archive metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$resumedArchiveBundleId",
        releaseId: "$resumedArchiveReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload resumed archive update");
    await app.control(
      "wait resumed archive metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$resumedArchiveBundleId",
        releaseId: "$resumedArchiveReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert resumed archive Bundle active",
      "runtime-bundle-id",
      "$resumedArchiveBundleId",
    );
    await app.assertText(
      "assert resumed archive marker",
      "runtime-scenario-marker",
      "resumed-archive-detox",
    );
  },
};
