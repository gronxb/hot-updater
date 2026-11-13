import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readSchemeAppleDevices } from "./schemeAppleDevices";

const { listAscDevices } = vi.hoisted(() => ({ listAscDevices: vi.fn() }));
vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  listAscDevices,
}));

const config = (ios: Record<string, unknown>) =>
  ({ nativeBuild: { ios: { adhoc: ios }, android: {} } }) as never;

let directory: string | undefined;
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("readSchemeAppleDevices", () => {
  it("says a scheme without signing.ascApiKey can't add a device, and asks Apple nothing", async () => {
    await expect(
      readSchemeAppleDevices(
        config({ bundleIdentifier: "com.example" }),
        "adhoc",
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "the scheme signs without signing.ascApiKey",
    });
    expect(listAscDevices).not.toHaveBeenCalled();
  });

  it("says a scheme that pins a profile can't add a device, and asks Apple nothing", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "apple-devices-"));
    const plist = path.join(directory, "ExportOptions.plist");
    fs.writeFileSync(
      plist,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>release-testing</string><key>signingStyle</key><string>manual</string></dict></plist>',
    );
    await expect(
      readSchemeAppleDevices(
        config({
          bundleIdentifier: "com.example",
          exportOptionsPlist: plist,
          signing: { ascApiKey: "secret:asc-api-key" },
        }),
        "adhoc",
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "the scheme pins a provisioning profile",
    });
    expect(listAscDevices).not.toHaveBeenCalled();
  });
});
