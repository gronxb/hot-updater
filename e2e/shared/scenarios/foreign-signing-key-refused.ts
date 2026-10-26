import type { ScenarioDefinition } from "./types.ts";

/**
 * The app verifies a bundle's signature with the public key it embeds: a
 * bundle signed with any other private key is refused before it installs,
 * and the same bundle signed with the project's key installs. Only the key
 * differs between the two deploys, so the refusal is the signature's.
 *
 * The project's key comes from `secret:bundle-signing-key`, read from its
 * variable, with the key file moved away and an empty key store: the controller first sees a deploy without
 * the variable refused for it, and the installed update proves the key read
 * from the secret is the one the app embeds.
 */
export const foreignSigningKeyRefusedScenario: ScenarioDefinition = {
  name: "foreign-signing-key-refused",
  run: async (app) => {
    await app.control(
      "deploy a bundle signed with a foreign key",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "foreign-signing-key-detox",
        mode: "reset",
        safeBundleIds: [],
        signingKey: "foreign",
        targetAppVersion: "1.0.x",
      },
    );
    await app.launch("launch the signing app");
    await app.tap(
      "attempt the foreign-key update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert the foreign-key update was refused",
      "update-action-result",
      "signature verification failed",
    );

    await app.control(
      "deploy the same bundle signed with the project's key from its secret",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "foreign-signing-key-detox",
        mode: "reset",
        safeBundleIds: [],
        signingKey: "secret",
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "signedBundleId",
        saveResultFieldsAs: { releaseId: "signedReleaseId" },
      },
    );
    await app.reload("reload with nothing staged");
    await app.assertText(
      "assert the built-in bundle still runs",
      "runtime-scenario-marker",
      "$initialMarker",
    );
    await app.tap(
      "install the project-signed update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert the project-signed update installed",
      "update-action-result",
      "current-channel -> installed ID $signedReleaseId",
      { exactText: true },
    );
    await app.reload("reload the project-signed update");
    await app.control(
      "wait for the project-signed update active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$signedBundleId",
        releaseId: "$signedReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert the project-signed marker",
      "runtime-scenario-marker",
      "foreign-signing-key-detox",
    );
  },
};
