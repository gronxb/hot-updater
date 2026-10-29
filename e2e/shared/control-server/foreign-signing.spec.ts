import { describe, expect, it } from "vitest";

import {
  refusedForMissingSigningSecret,
  withForeignSigning,
  withSecretSigning,
} from "./foreign-signing.ts";

describe("withForeignSigning", () => {
  it("signs with the foreign key and reads no native public key", () => {
    const source = [
      'import { defineConfig } from "hot-updater";',
      "export default defineConfig({",
      '  updateStrategy: "appVersion",',
      "  signing: {",
      "    enabled: true,",
      '    privateKeyPath: "./keys/private-key.pem",',
      "  },",
      "});",
    ].join("\n");

    expect(withForeignSigning(source, "/tmp/run/foreign.pem")).toBe(
      [
        'import { defineConfig } from "hot-updater";',
        "export default defineConfig({",
        '  updateStrategy: "appVersion",',
        '  signing: { enabled: true, privateKeyPath: "/tmp/run/foreign.pem" },',
        "  platform: { ios: { infoPlistPaths: [] }, android: { androidManifestPaths: [] } },",
        "});",
      ].join("\n"),
    );
  });

  it("refuses a config without exactly one signing object literal", () => {
    expect(() =>
      withForeignSigning("export default defineConfig({});", "/k.pem"),
    ).toThrow("sets signing as an object literal 0 times");
    expect(() =>
      withForeignSigning(
        "signing: { enabled: true }, x: { signing: { enabled: false } }",
        "/k.pem",
      ),
    ).toThrow("sets signing as an object literal 2 times");
  });
});

describe("withSecretSigning", () => {
  it("reads the key from the secret and keeps the native public key check", () => {
    const source = [
      'import { defineConfig } from "hot-updater";',
      "",
      "export default defineConfig({",
      "  signing: {",
      "    enabled: true,",
      '    privateKeyPath: "./keys/private-key.pem",',
      "  },",
      "});",
    ].join("\n");

    expect(withSecretSigning(source)).toBe(
      [
        'import { defineConfig, secret } from "hot-updater";',
        "",
        "export default defineConfig({",
        '  signing: secret("bundle-signing-key"),',
        "});",
      ].join("\n"),
    );
  });

  it("adds secret to the hot-updater import once", () => {
    expect(
      withSecretSigning(
        [
          'import { defineConfig, secret } from "hot-updater";',
          'export default defineConfig({ signing: { enabled: true, privateKeyPath: "k.pem" } });',
        ].join("\n"),
      ),
    ).toBe(
      [
        'import { defineConfig, secret } from "hot-updater";',
        'export default defineConfig({ signing: secret("bundle-signing-key") });',
      ].join("\n"),
    );
  });

  it("refuses a config without exactly one signing object literal", () => {
    expect(() => withSecretSigning("defineConfig({})")).toThrow(
      "sets signing as an object literal 0 times",
    );
  });
});

describe("refusedForMissingSigningSecret", () => {
  it("accepts only the CLI's refusal for the missing secret", () => {
    const refusal = [
      "Signing configuration error:",
      "  signing reads the bundle signing key bundle-signing-key, which is not in the localSecrets secrets adapter (HOT_UPDATER_BUNDLE_SIGNING_KEY in the environment, or /tmp/hot-updater-home/secrets/v0.85.0-0123456789ab/bundle-signing-key.json on this machine).",
      "  To create one, run: npx hot-updater secrets issue bundle-signing-key",
      "Deployment blocked. Fix the signing configuration and try again.",
    ].join("\n");

    expect(refusedForMissingSigningSecret(refusal)).toBe(true);
    // As deploy prints prepareBundleSigning's refusal: wrapped at spaces in
    // the prompt frame, colored.
    const printed = [
      "■  signing reads the bundle signing key bundle-signing-key, which",
      "│  is not in the localSecrets secrets adapter (HOT_UPDATER_BUNDLE_SIGNING_KEY in",
      "│  the environment, or",
      "│  /tmp/hot-updater-home/secrets/v0.85.0-0123456789ab/bundle-signing-key.json on",
      "│  this machine).",
      "│",
      "■  \u001b[31mDeployment blocked. Fix the signing configuration and try again.\u001b[39m",
    ].join("\n");
    expect(refusedForMissingSigningSecret(printed)).toBe(true);
    expect(
      refusedForMissingSigningSecret(
        "Signing configuration error:\n  Failed to load the bundle signing private key from privateKeyPath.\nDeployment blocked.",
      ),
    ).toBe(false);
    expect(refusedForMissingSigningSecret("Deployed release 0199")).toBe(false);
    expect(
      refusedForMissingSigningSecret(
        "which is not in the localSecrets secrets adapter (HOT_UPDATER_BUNDLE_SIGNING_KEY in the environment, or /tmp/secrets/x/other-key.json on this machine)\nDeployment blocked.",
      ),
    ).toBe(false);
  });
});
