import { describe, expect, it } from "vitest";

import { withForeignSigning } from "./foreign-signing.ts";

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
