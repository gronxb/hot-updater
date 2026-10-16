import type { ScenarioDefinition } from "./types.ts";

/**
 * Brownfield only: two Hot Updater instances in one host, `main` (the
 * example) and `widget` (a second React Native runtime with its own embedded
 * bundle and channel). Each stages and runs its own update; neither store
 * holds the other's bundle.
 */
export const brownfieldInstancesUpdateIndependentlyScenario: ScenarioDefinition =
  {
    name: "brownfield-instances-update-independently",
    run: async (app) => {
      await app.control(
        "deploy main bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "instances-main-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "mainBundleId",
          saveResultFieldsAs: { releaseId: "mainReleaseId" },
        },
      );
      await app.control(
        "deploy widget bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "widget",
          instance: "widget",
          marker: "instances-widget-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "widgetBundleId",
          saveResultFieldsAs: { releaseId: "widgetReleaseId" },
        },
      );
      await app.control(
        "turn on the widget instance",
        "/e2e/jobs/enable-widget",
      );
      await app.launch("launch both instances");
      await app.tap(
        "install main bundle",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert main install result",
        "update-action-result",
        "current-channel -> installed ID $mainReleaseId",
        { exactText: true },
      );
      await app.control(
        "wait main bundle pending",
        "/e2e/jobs/wait-for-metadata",
        { bundleId: "$mainBundleId", verificationPending: true },
      );
      // The widget checks and stages on its own when it mounts.
      await app.assertText(
        "assert widget install result",
        "widget-update-result",
        "widget -> installed ID $widgetReleaseId",
        { exactText: true },
      );
      await app.control(
        "wait widget bundle pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$widgetBundleId",
          instance: "widget",
          verificationPending: true,
        },
      );
      await app.reload("relaunch both instances");
      await app.control(
        "wait main bundle verified",
        "/e2e/jobs/wait-for-metadata",
        { bundleId: "$mainBundleId", verificationPending: false },
      );
      await app.control(
        "wait widget bundle verified",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$widgetBundleId",
          instance: "widget",
          verificationPending: false,
        },
      );
      await app.assertText(
        "assert main bundle",
        "runtime-bundle-id",
        "$mainBundleId",
      );
      await app.assertText(
        "assert main marker",
        "runtime-scenario-marker",
        "instances-main-detox",
      );
      await app.assertText(
        "assert widget bundle",
        "widget-bundle-id",
        "$widgetBundleId",
      );
      await app.assertText(
        "assert widget marker",
        "widget-scenario-marker",
        "instances-widget-detox",
      );
      await app.assertText(
        "assert widget channel",
        "widget-channel",
        "widget",
        {
          exactText: true,
        },
      );
      await app.control(
        "assert main store holds only main's bundle",
        "/e2e/assert-metadata-active",
        { absentBundleIds: ["$widgetBundleId"], bundleId: "$mainBundleId" },
      );
      await app.control(
        "assert widget store holds only the widget's bundle",
        "/e2e/assert-metadata-active",
        {
          absentBundleIds: ["$mainBundleId"],
          bundleId: "$widgetBundleId",
          instance: "widget",
        },
      );
    },
  };
