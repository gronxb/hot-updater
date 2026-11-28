import fs from "fs";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readIpaExportMethod } from "./ipaExportMethod";

const APP = "Payload/App.app";
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.app</string>
  <key>CFBundleVersion</key><string>42</string>
</dict></plist>`;

/** A profile's plist inside the bytes a CMS message wraps it in. */
const profile = (body: string) =>
  `0\u0082<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Entitlements</key><dict>${body.includes("get-task-allow") ? "<key>get-task-allow</key><true/>" : ""}</dict>
  <key>ExpirationDate</key><date>2030-01-02T03:04:05Z</date>
  ${body}
</dict></plist>
 \u0082`;

describe("readIpaExportMethod", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ipa-export-"));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const ipa = async (profileBody: string | null) => {
    const archive = new JSZip();
    archive.file(`${APP}/Info.plist`, INFO_PLIST);
    if (profileBody !== null) {
      archive.file(`${APP}/embedded.mobileprovision`, profile(profileBody));
    }
    const file = path.join(dir, `App-${Math.random()}.ipa`);
    await fs.promises.writeFile(
      file,
      await archive.generateAsync({ type: "uint8array" }),
    );
    return file;
  };

  const DEVICES =
    "<key>ProvisionedDevices</key><array><string>00008030-001C2D3E4F5A6B7C</string></array>";

  it("records the export options' method when the profile the .ipa embeds confirms it", async () => {
    // Xcode's current names and the older ones.
    for (const method of ["release-testing", "ad-hoc"]) {
      expect(await readIpaExportMethod(await ipa(DEVICES), method)).toBe(
        "ad-hoc",
      );
    }
    for (const method of ["debugging", "development"]) {
      expect(
        await readIpaExportMethod(
          await ipa(`${DEVICES}<!-- get-task-allow -->`),
          method,
        ),
      ).toBe("development");
    }
    expect(
      await readIpaExportMethod(
        await ipa("<key>ProvisionsAllDevices</key><true/>"),
        "enterprise",
      ),
    ).toBe("enterprise");
    for (const method of ["app-store-connect", "app-store"]) {
      expect(await readIpaExportMethod(await ipa(""), method)).toBe(
        "app-store",
      );
    }
  });

  it("records nothing when the export options and the profile disagree", async () => {
    expect(
      await readIpaExportMethod(await ipa(DEVICES), "app-store-connect"),
    ).toBeNull();
    expect(
      await readIpaExportMethod(await ipa(""), "release-testing"),
    ).toBeNull();
    expect(
      await readIpaExportMethod(
        await ipa(`${DEVICES}<!-- get-task-allow -->`),
        "release-testing",
      ),
    ).toBeNull();
    // A method no .ipa of these is exported with.
    expect(await readIpaExportMethod(await ipa(""), "validation")).toBeNull();
  });

  it("records nothing without export options, as an imported .ipa has none", async () => {
    expect(await readIpaExportMethod(await ipa(DEVICES), null)).toBeNull();
    expect(await readIpaExportMethod(await ipa(""), null)).toBeNull();
  });

  it("records nothing for an .ipa with no profile, which proves no export method", async () => {
    expect(
      await readIpaExportMethod(await ipa(null), "app-store-connect"),
    ).toBeNull();
  });

  it("records nothing for a file it can't read", async () => {
    const file = path.join(dir, "broken.ipa");
    await fs.promises.writeFile(file, "not a zip");
    expect(await readIpaExportMethod(file, "release-testing")).toBeNull();
  });
});
