import type { ScenarioDefinition } from "./types.ts";

/**
 * Brownfield only: the widget's native check stages a widget OTA in the
 * background, and the next launch runs main's new OTA and that widget OTA,
 * which throws before its first content. The widget's fatal ends the process; at the next
 * start only the widget rolls back to its built-in bundle and records the
 * crash, while main keeps its new OTA with no crash history.
 */
export const brownfieldInstanceCrashRollsBackOnlyItselfScenario: ScenarioDefinition =
  {
    name: "brownfield-instance-crash-rolls-back-only-itself",
    run: async (app) => {
      await app.control(
        "capture built-in bundle",
        "/e2e/capture-built-in-bundle-id",
        {},
        { saveResultAs: "builtInBundleId" },
      );
      await app.control(
        "deploy main stable bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "instance-crash-main-stable-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "mainStableBundleId",
          saveResultFieldsAs: { releaseId: "mainStableReleaseId" },
        },
      );
      await app.control(
        "turn on the widget instance",
        "/e2e/jobs/enable-widget",
        // Long enough for the held artifact request below.
        { requestTimeoutMs: 120_000 },
        { saveResultFieldsAs: { nonce: "widgetCheckNonce" } },
      );
      await app.launch("launch main stable");
      await app.tap(
        "install main stable",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert main stable install result",
        "update-action-result",
        "current-channel -> installed ID $mainStableReleaseId",
        { exactText: true },
      );
      await app.control(
        "wait main stable pending",
        "/e2e/jobs/wait-for-metadata",
        { bundleId: "$mainStableBundleId", verificationPending: true },
      );
      await app.reload("reload main stable");
      await app.control(
        "wait main stable verified",
        "/e2e/jobs/wait-for-metadata",
        { bundleId: "$mainStableBundleId", verificationPending: false },
      );
      await app.control(
        "deploy main next bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "instance-crash-main-next-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "mainNextBundleId",
          saveResultFieldsAs: { releaseId: "mainNextReleaseId" },
        },
      );
      // Only the widget's built-in bundle is safe: its OTA throws.
      await app.control(
        "deploy widget crash bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "widget",
          instance: "widget",
          marker: "instance-crash-widget-detox",
          mode: "crash",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "widgetCrashBundleId",
          saveResultFieldsAs: { releaseId: "widgetCrashReleaseId" },
        },
      );
      // Hold artifacts until the widget runs its built-in bundle, so its
      // background download stages the crash bundle for the next start
      // instead of running it in this one.
      await app.control("hold the widget artifact", "/e2e/proxy-control", {
        holdArtifacts: true,
      });
      await app.launch("launch to stage both updates");
      await app.control(
        "wait widget native check pending",
        "/e2e/jobs/wait-for-native-check",
        { instance: "widget", nonce: "$widgetCheckNonce", status: "pending" },
      );
      await app.control("release the widget artifact", "/e2e/proxy-control", {
        holdArtifacts: false,
      });
      await app.control(
        "wait widget crash pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$widgetCrashBundleId",
          instance: "widget",
          verificationPending: true,
        },
      );
      await app.tap(
        "install main next",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert main next install result",
        "update-action-result",
        "current-channel -> installed ID $mainNextReleaseId",
        { exactText: true },
      );
      await app.control(
        "wait main next pending",
        "/e2e/jobs/wait-for-metadata",
        { bundleId: "$mainNextBundleId", verificationPending: true },
      );
      // Main runs its pending next bundle while the widget's bundle throws.
      await app.launch("launch the widget crash bundle", { expectCrash: true });
      await app.control(
        "wait widget recovery to its built-in bundle",
        "/e2e/wait-for-crash-recovery",
        {
          crashedBundleId: "$widgetCrashBundleId",
          instance: "widget",
          stableBundleId: "$builtInBundleId",
        },
      );
      await app.control(
        "assert widget crash history",
        "/e2e/assert-crash-history",
        { bundleId: "$widgetCrashBundleId", instance: "widget" },
      );
      await app.control(
        "assert widget recovery report",
        "/e2e/assert-launch-report",
        {
          fromBundleId: "$widgetCrashBundleId",
          fromReleaseId: "$widgetCrashReleaseId",
          instance: "widget",
          status: "RECOVERED",
        },
      );
      // The widget's fatal charged main nothing: its next bundle runs.
      await app.control(
        "wait main next verified",
        "/e2e/jobs/wait-for-metadata",
        { bundleId: "$mainNextBundleId", verificationPending: false },
      );
      await app.control(
        "assert main next active",
        "/e2e/assert-metadata-active",
        {
          absentBundleIds: ["$widgetCrashBundleId"],
          bundleId: "$mainNextBundleId",
        },
      );
      await app.assertText(
        "assert main next bundle",
        "runtime-bundle-id",
        "$mainNextBundleId",
      );
      await app.assertText(
        "assert main next marker",
        "runtime-scenario-marker",
        "instance-crash-main-next-detox",
      );
      await app.assertText(
        "assert main crash history empty",
        "crash-history-count",
        "0",
        { exactText: true },
      );
      await app.assertText(
        "assert main not recovered",
        "launch-status-result",
        [
          "Current Launch Status: UNCHANGED",
          "Current Launch Status: UPDATE_APPLIED",
        ],
      );
      await app.assertText(
        "assert widget built-in bundle",
        "widget-bundle-id",
        "$builtInBundleId",
      );
      await app.assertText(
        "assert widget built-in marker",
        "widget-scenario-marker",
        "$initialMarker",
      );
      await app.assertText(
        "assert widget crash history count",
        "widget-crash-history-count",
        "1",
        { exactText: true },
      );
    },
  };
