import type { DetoxScenarioDefinition } from "./types.ts";

export const explicitEmbeddedReceiptScenario: DetoxScenarioDefinition = {
  name: "explicit-embedded-receipt",
  run: async (app) => {
    await app.control(
      "capture embedded Bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "embeddedBundleId" },
    );
    await app.control(
      "deploy embedded source",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "embedded-source-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "embeddedSourceBundleId",
        saveResultFieldsAs: { releaseId: "embeddedSourceReleaseId" },
      },
    );
    await app.launch("launch embedded source");
    await app.tap(
      "install embedded source",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait embedded source pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$embeddedSourceBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload embedded source");
    await app.control(
      "wait embedded source active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$embeddedSourceBundleId",
        verificationPending: false,
      },
    );
    await app.control(
      "create explicit EMBEDDED Release",
      "/e2e/jobs/create-rollback-release",
      { sourceReleaseId: "$embeddedSourceReleaseId", toBundleId: null },
      { saveResultFieldsAs: { releaseId: "embeddedReleaseId" } },
    );
    await app.tap(
      "apply explicit EMBEDDED Release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert EMBEDDED action",
      "update-action-result",
      "current-channel -> selected EMBEDDED Release $embeddedReleaseId",
      { exactText: true },
    );
    await app.assertText(
      "assert EMBEDDED receipt before reload",
      "runtime-release-state",
      ["$embeddedReleaseId", '"selectionKind":"EMBEDDED"'],
    );
    await app.reload("reload explicit EMBEDDED");
    await app.assertText(
      "assert embedded Bundle active",
      "runtime-bundle-id",
      "$embeddedBundleId",
    );
    await app.assertText(
      "assert EMBEDDED receipt persisted",
      "runtime-release-state",
      ["$embeddedReleaseId", '"selectionKind":"EMBEDDED"'],
    );
  },
};
