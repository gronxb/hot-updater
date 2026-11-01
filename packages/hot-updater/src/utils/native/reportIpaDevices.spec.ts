import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log } = vi.hoisted(() => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn() },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log },
}));

import { reportIpaDevices } from "./reportIpaDevices";

const PHONE = "00008030-001C2D3E4F5A6B7C";
const LATER_PHONE = "00008110-000A1B2C3D4E5F60";
const APP = "Payload/App.app";
const INFO_PLIST = `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleVersion</key><string>1</string></dict></plist>`;

let directory: string;

const writeIpa = async (name: string, profile: string | null) => {
  const archive = new JSZip();
  archive.file(`${APP}/Info.plist`, INFO_PLIST);
  if (profile !== null) {
    archive.file(`${APP}/embedded.mobileprovision`, profile);
  }
  const file = path.join(directory, name);
  await fs.writeFile(file, await archive.generateAsync({ type: "uint8array" }));
  return file;
};

const profileListing = (devices: readonly string[]) =>
  `\u0000<?xml version="1.0"?><plist version="1.0"><dict><key>ProvisionedDevices</key><array>${devices
    .map((udid) => `<string>${udid}</string>`)
    .join("")}</array></dict></plist>\u0000`;

const logged = (method: keyof typeof log) =>
  log[method].mock.calls.map(([line]) => String(line)).join("\n");

beforeEach(async () => {
  vi.clearAllMocks();
  process.exitCode = 0;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ipa-devices-"));
});

afterEach(async () => {
  process.exitCode = 0;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("reportIpaDevices", () => {
  it("prints an .ipa's device count, and nothing else without a UDID", async () => {
    await reportIpaDevices({
      artifactPath: await writeIpa(
        "a.ipa",
        profileListing([PHONE, LATER_PHONE]),
      ),
      scheme: "sandbox",
      udids: [],
    });

    expect(logged("info")).toBe("Devices in this .ipa: 2");
    expect(log.success).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("prints included for a passed UDID, whatever its case", async () => {
    await reportIpaDevices({
      artifactPath: await writeIpa("a.ipa", profileListing([PHONE])),
      scheme: "sandbox",
      udids: [PHONE.toLowerCase()],
    });

    expect(logged("success")).toBe(`${PHONE.toLowerCase()} included`);
    expect(process.exitCode).toBe(0);
  });

  it("negative control: an IPA built before a device was added excludes it, says so, and fails; a newer IPA includes it", async () => {
    const before = await writeIpa("before.ipa", profileListing([PHONE]));
    await reportIpaDevices({
      artifactPath: before,
      scheme: "sandbox",
      udids: [LATER_PHONE],
    });
    expect(log.success).not.toHaveBeenCalled();
    expect(logged("warn")).toContain(`${LATER_PHONE} isn't in this .ipa.`);
    expect(logged("warn")).toContain(
      "native-build devices list --scheme sandbox",
    );
    expect(logged("warn")).toContain(
      'grep -laE "(Ad Hoc Provisioning Profile|XC Ad Hoc): com.example.app" ~/Library/Developer/Xcode/UserData/"Provisioning Profiles"/*',
    );
    expect(process.exitCode).toBe(1);

    vi.clearAllMocks();
    process.exitCode = 0;
    await reportIpaDevices({
      artifactPath: await writeIpa(
        "after.ipa",
        profileListing([PHONE, LATER_PHONE]),
      ),
      scheme: "sandbox",
      udids: [LATER_PHONE],
    });
    expect(logged("success")).toBe(`${LATER_PHONE} included`);
    expect(log.warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("prints nothing for an App Store export, which lists no devices", async () => {
    await reportIpaDevices({
      artifactPath: await writeIpa(
        "store.ipa",
        profileListing([]).replace(
          /<key>ProvisionedDevices<\/key><array><\/array>/u,
          "",
        ),
      ),
      scheme: "sandbox",
      udids: [],
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("says an App Store export can't take a passed UDID, with the export to use", async () => {
    await reportIpaDevices({
      artifactPath: await writeIpa("store.ipa", null),
      scheme: "sandbox",
      udids: [PHONE],
    });
    expect(logged("warn")).toBe(
      `This build lists no devices, so ${PHONE} can't install it.\nExport with method release-testing in the scheme's exportOptionsPlist.`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("stays quiet about a simulator app or an archive, with no UDID to look for", async () => {
    for (const artifactPath of [
      path.join(directory, "App.app"),
      path.join(directory, "App.xcarchive"),
    ]) {
      await reportIpaDevices({ artifactPath, scheme: "sim", udids: [] });
    }
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("says a build that isn't an .ipa can't take a passed UDID, and fails", async () => {
    await reportIpaDevices({
      artifactPath: path.join(directory, "App.xcarchive"),
      scheme: "sim",
      udids: [PHONE],
    });
    expect(logged("warn")).toContain("isn't an .ipa");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["missing", null],
    ["corrupt", "not a zip"],
  ])(
    "never reads a %s .ipa as having no devices: it says they're unknown, and fails only for a passed UDID",
    async (_, content) => {
      const artifactPath = path.join(directory, "broken.ipa");
      if (content !== null) await fs.writeFile(artifactPath, content);

      await reportIpaDevices({ artifactPath, scheme: "sandbox", udids: [] });
      expect(logged("warn")).toContain("its devices are unknown");
      expect(log.success).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);

      await reportIpaDevices({
        artifactPath,
        scheme: "sandbox",
        udids: [PHONE],
      });
      expect(log.success).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );
});
