import type { DetoxScenarioDefinition } from "./types.ts";

export const fingerprintInitialInstallScenario: DetoxScenarioDefinition = {
  name: "fingerprint-initial-install",
  run: async (app) => {
    await app.control(
      "deploy fingerprint bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "fingerprint-initial-detox",
        mode: "reset",
        safeBundleIds: [],
        strategy: "fingerprint",
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "fingerprintBundleId",
        saveResultFieldsAs: { releaseId: "fingerprintReleaseId" },
      },
    );
    await app.launch("launch fingerprint app");
    await app.tap(
      "install fingerprint update",
      "action-install-fingerprint-update",
    );
    await app.assertText(
      "assert fingerprint install",
      "update-action-result",
      "fingerprint -> installed ID $fingerprintReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait fingerprint metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$fingerprintBundleId",
        releaseId: "$fingerprintReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload fingerprint update");
    await app.control(
      "wait fingerprint metadata active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$fingerprintBundleId",
        releaseId: "$fingerprintReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert fingerprint Release",
      "runtime-release-state",
      ["$fingerprintReleaseId", '"selectionKind":"BUNDLE"'],
    );
    await app.assertText(
      "assert fingerprint marker",
      "runtime-scenario-marker",
      "fingerprint-initial-detox",
    );
  },
};
