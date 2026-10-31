import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSettingsOverScheme } from "./writeBuildXcconfig";
import {
  assertSandboxExportOptions,
  resolveSandboxExportOptions,
  writeAppStoreConnectExportOptions,
} from "./xcodeSigning";

let root: string;

const plist = async (body: string) => {
  const file = path.join(root, "Custom.plist");
  await fs.writeFile(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>${body}</dict></plist>
`,
  );
  return file;
};
const STORE = "<key>method</key><string>app-store-connect</string>";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-export-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a sandbox scheme's export options", () => {
  it("adds the internal-only flag only to a sandbox export it writes", async () => {
    const internal = await fs.readFile(
      await writeAppStoreConnectExportOptions(root, {
        internalTestingOnly: true,
      }),
      "utf-8",
    );
    expect(internal).toContain(
      "<key>testFlightInternalTestingOnly</key>\n  <true/>",
    );
    expect(internal).toContain("<string>app-store-connect</string>");

    const normal = await fs.readFile(
      await writeAppStoreConnectExportOptions(root),
      "utf-8",
    );
    expect(normal).not.toContain("testFlightInternalTestingOnly");
  });

  it("refuses an App Store Connect export that turns internal testing off", async () => {
    const file = await plist(
      `${STORE}<key>testFlightInternalTestingOnly</key><false/>`,
    );
    await expect(assertSandboxExportOptions("beta", file)).rejects.toThrow(
      "The sandbox scheme beta turns testFlightInternalTestingOnly off in exportOptionsPlist.\nRemove the key, or set it to true.",
    );
  });

  it("uses an export as it is when it turns internal testing on, or never reaches App Store Connect", async () => {
    const on = await plist(
      `${STORE}<key>testFlightInternalTestingOnly</key><true/>`,
    );
    expect(await resolveSandboxExportOptions("beta", on, root)).toBe(on);
    const adHoc = await plist("<key>method</key><string>ad-hoc</string>");
    expect(await resolveSandboxExportOptions("beta", adHoc, root)).toBe(adHoc);
  });

  it.runIf(process.platform === "darwin")(
    "turns internal testing on in a copy when an App Store Connect export leaves it out",
    async () => {
      const original = await plist(STORE);
      const before = await fs.readFile(original, "utf-8");
      const directory = path.join(root, "out");
      await fs.mkdir(directory);

      const copy = await resolveSandboxExportOptions(
        "beta",
        original,
        directory,
      );

      expect(copy).not.toBe(original);
      expect(await fs.readFile(original, "utf-8")).toBe(before);
      expect(
        execFileSync(
          "plutil",
          ["-extract", "testFlightInternalTestingOnly", "raw", "-o", "-", copy],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("true");
    },
  );
});

describe("buildSettingsOverScheme", () => {
  it("brings the sandbox sources back only for a sandbox scheme", () => {
    expect(
      buildSettingsOverScheme({ minBundleId: "id", sandbox: true }),
    ).toEqual({
      HOT_UPDATER_MIN_BUNDLE_ID: "id",
      INCLUDED_SOURCE_FILE_NAMES: "HotUpdaterSandbox*",
    });
    for (const sandbox of [false, undefined]) {
      expect(buildSettingsOverScheme({ minBundleId: "id", sandbox })).toEqual({
        HOT_UPDATER_MIN_BUNDLE_ID: "id",
      });
    }
  });
});
