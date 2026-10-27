import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBuiltApp } from "./readBuiltApp";

let appPath: string;

const writeInfoPlist = async (
  directory: string,
  values: Record<string, string>,
) => {
  await fs.mkdir(directory, { recursive: true });
  const plist = path.join(directory, "Info.plist");
  await execa("plutil", ["-create", "xml1", plist]);
  for (const [key, value] of Object.entries(values)) {
    await execa("plutil", ["-insert", key, "-string", value, plist]);
  }
};

beforeEach(async () => {
  appPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-app-")),
    "App.app",
  );
  await writeInfoPlist(appPath, {
    CFBundleShortVersionString: "2.0.0",
    CFBundleVersion: "66",
    HOT_UPDATER_CHANNEL: "beta",
  });
});

afterEach(async () => {
  await fs.rm(path.dirname(appPath), { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("readBuiltApp", () => {
  it("reads the app version, build number and channel from the app's Info.plist", async () => {
    await expect(readBuiltApp(appPath)).resolves.toEqual({
      appVersion: "2.0.0",
      channel: "beta",
      buildNumber: "66",
    });
  });

  it("reads the app's own channel, whatever its embedded frameworks declare", async () => {
    // The bundle a brownfield host passes is chosen at runtime.
    await writeInfoPlist(
      path.join(appPath, "Frameworks", "Brownfield.framework"),
      { HOT_UPDATER_CHANNEL: "brownfield" },
    );

    await expect(readBuiltApp(appPath)).resolves.toMatchObject({
      channel: "beta",
    });
  });

  it("reads no channel when the app declares none", async () => {
    await execa("plutil", [
      "-remove",
      "HOT_UPDATER_CHANNEL",
      path.join(appPath, "Info.plist"),
    ]);

    await expect(readBuiltApp(appPath)).resolves.toMatchObject({
      channel: null,
    });
  });
});
