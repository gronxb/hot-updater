import type { ScenarioDefinition } from "./types.ts";

/**
 * Brownfield only: with `main` and `widget` both on an OTA, disabling the
 * widget's Release returns only the widget to its built-in bundle; main keeps
 * its OTA.
 */
export const brownfieldInstanceRollbackIsolatedScenario: ScenarioDefinition = {
  name: "brownfield-instance-rollback-isolated",
  run: async (app) => {
    await app.control(
      "capture built-in bundle",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "builtInBundleId" },
    );
    await app.control(
      "deploy main bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "isolated-main-detox",
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
        marker: "isolated-widget-detox",
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
      // Long enough for the held artifact request below.
      { requestTimeoutMs: 120_000 },
      { saveResultFieldsAs: { nonce: "widgetCheckNonce" } },
    );
    // Hold artifacts until the widget runs its current bundle, so its
    // background download stages the update for the next start.
    await app.control("hold the widget artifact", "/e2e/proxy-control", {
      holdArtifacts: true,
    });
    await app.launch("launch both instances");
    await app.control(
      "wait widget native check pending",
      "/e2e/jobs/wait-for-native-check",
      { instance: "widget", nonce: "$widgetCheckNonce", status: "pending" },
    );
    await app.control("release the widget artifact", "/e2e/proxy-control", {
      holdArtifacts: false,
    });
    await app.control(
      "wait widget bundle pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$widgetBundleId",
        instance: "widget",
        verificationPending: true,
      },
    );
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
      {
        bundleId: "$mainBundleId",
        verificationPending: true,
      },
    );
    await app.reload("relaunch both instances on their OTAs");
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
    await app.control("disable the widget release", "/e2e/jobs/patch-release", {
      enabled: false,
      releaseId: "$widgetReleaseId",
    });
    // A rollback to the built-in bundle is required: the widget's native
    // check applies it before its runtime starts, in this same start.
    await app.reload("relaunch after the widget release is disabled");
    await app.control(
      "wait widget native check applies its built-in bundle",
      "/e2e/jobs/wait-for-native-check",
      { instance: "widget", nonce: "$widgetCheckNonce", status: "ready" },
    );
    await app.control(
      "assert widget metadata reset",
      "/e2e/assert-metadata-reset",
      { instance: "widget" },
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
      "assert main bundle kept",
      "runtime-bundle-id",
      "$mainBundleId",
    );
    await app.assertText(
      "assert main marker kept",
      "runtime-scenario-marker",
      "isolated-main-detox",
    );
    await app.control(
      "assert main metadata kept",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$mainBundleId",
      },
    );
    // The disabled Release stays out of the widget's next check.
    await app.reload("relaunch the widget on its built-in bundle");
    await app.control(
      "wait widget native check up to date",
      "/e2e/jobs/wait-for-native-check",
      { instance: "widget", nonce: "$widgetCheckNonce", status: "upToDate" },
    );
    await app.assertText(
      "assert widget stays on its built-in bundle",
      "widget-bundle-id",
      "$builtInBundleId",
    );
  },
};
