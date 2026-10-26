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
      "export default defineConfig({",
      "  signing: {",
      "    enabled: true,",
      '    privateKeyPath: "./keys/private-key.pem",',
      "  },",
      "});",
    ].join("\n");

    expect(withSecretSigning(source)).toBe(
      [
        "export default defineConfig({",
        '  signing: { enabled: true, privateKey: "secret:bundle-signing-key" },',
        "});",
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
      "  Failed to resolve the bundle signing provider public key. signing.privateKey reads the bundle signing key bundle-signing-key, which is not in the envSecrets secrets adapter (HOT_UPDATER_BUNDLE_SIGNING_KEY in the environment or .env.hotupdater). Set it to the RSA private key in PEM, or generate a key pair with `npx hot-updater keys generate --secret bundle-signing-key`.",
      "Deployment blocked. Fix the signing configuration and try again.",
    ].join("\n");

    expect(refusedForMissingSigningSecret(refusal)).toBe(true);
    expect(
      refusedForMissingSigningSecret(
        "Signing configuration error:\n  Failed to load the local bundle signing private key.\nDeployment blocked.",
      ),
    ).toBe(false);
    expect(refusedForMissingSigningSecret("Deployed release 0199")).toBe(false);
  });
});
