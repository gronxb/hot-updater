import fs from "node:fs/promises";
import path from "node:path";

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

/**
 * What the CLI prints for the refusal, rendered from its own message and
 * printer by hot-updater's signingRefusal.spec.ts, which fails when the
 * wording or the layout changes.
 */
const printedRefusal = await fs.readFile(
  path.join(
    import.meta.dirname,
    "__fixtures__/missing-signing-secret-refusal.txt",
  ),
  "utf8",
);

describe("refusedForMissingSigningSecret", () => {
  it("accepts the refusal the CLI prints, plain or colored", () => {
    expect(refusedForMissingSigningSecret(printedRefusal)).toBe(true);
    // As a deploy log has it: colored, after the deploy's other lines.
    const colored = [
      "┌  Hot Updater deploy",
      ...printedRefusal
        .split("\n")
        .map((line) =>
          line.startsWith("■  ")
            ? `\u001b[31m■\u001b[39m  ${line.slice(3)}`
            : line,
        ),
    ].join("\n");
    expect(refusedForMissingSigningSecret(colored)).toBe(true);
  });

  it("refuses anything but that refusal", () => {
    // Not blocked.
    expect(
      refusedForMissingSigningSecret(
        printedRefusal.replace("Deployment blocked.", "Deploying."),
      ),
    ).toBe(false);
    // A release was recorded after all.
    expect(
      refusedForMissingSigningSecret(
        `${printedRefusal}│  ID       0199c1d2-3e4f-7a5b-8c6d-9e0f1a2b3c4d\n`,
      ),
    ).toBe(false);
    // Another secret, or the command wrapped into the prose before it.
    expect(
      refusedForMissingSigningSecret(
        printedRefusal.replaceAll("bundle-signing-key", "other-key"),
      ),
    ).toBe(false);
    expect(
      refusedForMissingSigningSecret(
        [
          "■  bundle-signing-key isn't on this machine.",
          "│  Check the name, set HOT_UPDATER_BUNDLE_SIGNING_KEY, or import your key: npx",
          "│  hot-updater secrets put bundle-signing-key <key.pem>",
          "│",
          "■  Deployment blocked. Fix the signing configuration and try again.",
        ].join("\n"),
      ),
    ).toBe(false);
    // The block before the reason is another refusal's.
    expect(
      refusedForMissingSigningSecret(
        [
          "■  Deployment blocked. Fix the signing configuration and try again.",
          ...printedRefusal.split("\n").slice(0, 4),
        ].join("\n"),
      ),
    ).toBe(false);
    expect(refusedForMissingSigningSecret("Deployed release 0199")).toBe(false);
  });
});
