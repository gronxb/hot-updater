import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  provisioningProfileDirs,
  removeSavedAdHocProfiles,
} from "./savedAdHocProfiles";

const TEAM = "ABCDE12345";

const profile = ({
  uuid,
  team = TEAM,
  applicationId = `${TEAM}.com.example.app`,
  xcodeManaged = true,
  devices = ["00008030-001c2d3e4f5a6b7c"],
  getTaskAllow = false,
}: {
  uuid: string;
  team?: string;
  applicationId?: string;
  xcodeManaged?: boolean;
  devices?: readonly string[] | null;
  getTaskAllow?: boolean;
}) => `0\u0082<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Entitlements</key><dict>
    <key>application-identifier</key><string>${applicationId}</string>
    <key>get-task-allow</key><${getTaskAllow}/>
  </dict>
  <key>IsXcodeManaged</key><${xcodeManaged}/>
  <key>Name</key><string>XC Ad Hoc: com.example.app</string>
  ${devices === null ? "" : `<key>ProvisionedDevices</key><array>${devices.map((udid) => `<string>${udid}</string>`).join("")}</array>`}
  <key>TeamIdentifier</key><array><string>${team}</string></array>
  <key>UUID</key><string>${uuid}</string>
</dict></plist> \u0082`;

describe("removeSavedAdHocProfiles", () => {
  let home: string;
  let dirs: string[];
  const save = (dir: number, uuid: string, text: string) =>
    fs.promises.writeFile(
      path.join(dirs[dir]!, `${uuid}.mobileprovision`),
      text,
      "latin1",
    );
  const left = async () =>
    (
      await Promise.all(
        dirs.map((dir) => fs.promises.readdir(dir).catch(() => [])),
      )
    )
      .flat()
      .sort();

  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hu-profiles-"));
    dirs = provisioningProfileDirs(home);
    for (const dir of dirs) await fs.promises.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it("deletes only Xcode's ad hoc profiles of the app's bundle IDs in the team, in both folders", async () => {
    await save(0, "app-old", profile({ uuid: "app-old" }));
    await save(
      1,
      "extension",
      profile({
        uuid: "extension",
        applicationId: `${TEAM}.com.example.app.widget`,
      }),
    );
    await save(
      1,
      "other-team",
      profile({
        uuid: "other-team",
        team: "ZZZZZ99999",
        applicationId: "ZZZZZ99999.com.example.app",
      }),
    );
    await save(1, "manual", profile({ uuid: "manual", xcodeManaged: false }));
    await save(
      1,
      "development",
      profile({ uuid: "development", getTaskAllow: true }),
    );
    await save(1, "store", profile({ uuid: "store", devices: null }));
    await save(
      1,
      "other-app",
      profile({
        uuid: "other-app",
        applicationId: `${TEAM}.com.example.apple`,
      }),
    );
    await fs.promises.writeFile(
      path.join(dirs[1]!, "broken.mobileprovision"),
      "not a profile",
    );

    const result = await removeSavedAdHocProfiles({
      teamId: TEAM,
      bundleIds: ["com.example.app", "com.example.app.widget"],
      dirs,
    });

    expect([...result.removed].sort()).toEqual(["app-old", "extension"]);
    expect(result.failed).toEqual([]);
    expect(await left()).toEqual([
      "broken.mobileprovision",
      "development.mobileprovision",
      "manual.mobileprovision",
      "other-app.mobileprovision",
      "other-team.mobileprovision",
      "store.mobileprovision",
    ]);
  });

  it("removes nothing from folders that don't exist", async () => {
    expect(
      await removeSavedAdHocProfiles({
        teamId: TEAM,
        bundleIds: ["com.example.app"],
        dirs: [path.join(home, "missing")],
      }),
    ).toEqual({ removed: [], failed: [] });
  });
});
