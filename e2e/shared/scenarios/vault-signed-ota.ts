import type { ScenarioDefinition } from "./types.ts";

/**
 * A deploy as CI runs it with the console's vault: the deploy holds only
 * `HOT_UPDATER_CONSOLE_URL` and one vault token, reads its credentials from
 * the vault's `deploy-credentials`, and the console signs the bundle with the
 * vault's bundle signing key. The device verifies that signature with the
 * public key it embeds before it applies the update.
 */
export const vaultSignedOtaScenario: ScenarioDefinition = {
  name: "vault-signed-ota",
  run: async (app) => {
    await app.control(
      "start the vault console",
      "/e2e/jobs/start-vault-console",
      {},
    );
    try {
      await app.control(
        "deploy with the vault's credentials and signature",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          credentials: "vault",
          marker: "vault-signed-ota-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "vaultBundleId",
          saveResultFieldsAs: { releaseId: "vaultReleaseId" },
        },
      );
    } finally {
      await app.control(
        "stop the vault console",
        "/e2e/stop-vault-console",
        {},
      );
    }
    await app.launch("launch the vault app");
    await app.tap(
      "install the vault-signed update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert the vault-signed update installed",
      "update-action-result",
      "current-channel -> installed ID $vaultReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait for the vault-signed update pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$vaultBundleId",
        releaseId: "$vaultReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload the vault-signed update");
    await app.control(
      "wait for the vault-signed update active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$vaultBundleId",
        releaseId: "$vaultReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert the vault-signed marker",
      "runtime-scenario-marker",
      "vault-signed-ota-detox",
    );
  },
};
