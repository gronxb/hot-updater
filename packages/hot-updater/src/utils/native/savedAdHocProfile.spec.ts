import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeSavedAdHocProfileCommand } from "./savedAdHocProfile";

let home: string;
let folder: string;

/** A saved profile as Xcode keeps one: a plist among a CMS message's bytes. */
const saveProfile = (file: string, name: string) =>
  fs.writeFile(
    path.join(folder, `${file}.mobileprovision`),
    Buffer.concat([
      Buffer.from([0x30, 0x82, 0x00, 0xff]),
      Buffer.from(
        `<?xml version="1.0"?><plist version="1.0"><dict><key>Name</key>\n\t<string>${name}</string>\n</dict></plist>`,
      ),
      Buffer.from([0xa0, 0x00]),
    ]),
  );

const AD_HOC = "iOS Team Ad Hoc Provisioning Profile";

/** Runs the printed command in a shell, in a scratch home, and lists what's left. */
const run = async (...bundleIds: string[]) => {
  execFileSync("sh", ["-c", removeSavedAdHocProfileCommand(bundleIds)], {
    cwd: home,
    env: { ...process.env, HOME: home },
  });
  return (await fs.readdir(folder))
    .map((file) => file.replace(".mobileprovision", ""))
    .sort();
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "saved-profiles-"));
  folder = path.join(
    home,
    "Library/Developer/Xcode/UserData/Provisioning Profiles",
  );
  await fs.mkdir(folder, { recursive: true });
  await Promise.all([
    saveProfile("app", `${AD_HOC}: com.example.app`),
    saveProfile("app-xc", "XC Ad Hoc: com.example.app"),
    saveProfile("app2", `${AD_HOC}: com.example.app2`),
    saveProfile("app-sub", `${AD_HOC}: com.example.app.sub`),
    saveProfile("dots", `${AD_HOC}: comXexampleYapp`),
    saveProfile("prefixed", `${AD_HOC}: xcom.example.app`),
    saveProfile("wildcard", `${AD_HOC}: *`),
    saveProfile("team", `${AD_HOC}: Q3QT4ZF343.com.example.app`),
    saveProfile(
      "development",
      "iOS Team Provisioning Profile: com.example.app",
    ),
    saveProfile(
      "store",
      "iOS Team Store Provisioning Profile: com.example.app",
    ),
  ]);
});

afterEach(() => fs.rm(home, { recursive: true, force: true }));

describe.runIf(process.platform !== "win32")(
  "the printed command that removes saved profiles",
  () => {
    it("removes only this exact app's ad hoc profiles", async () => {
      expect(await run("com.example.app")).toEqual([
        "app-sub",
        "app2",
        "development",
        "dots",
        "prefixed",
        "store",
        "team",
        "wildcard",
      ]);
    });

    it("removes an extension's only when its bundle ID is named", async () => {
      expect(await run("com.example.app", "com.example.app.sub")).toEqual([
        "app2",
        "development",
        "dots",
        "prefixed",
        "store",
        "team",
        "wildcard",
      ]);
    });

    it("removes nothing, and fails nothing, when no profile matches", async () => {
      const before = await fs.readdir(folder);
      await run("com.other.app");
      expect(await fs.readdir(folder)).toHaveLength(before.length);
    });

    it("treats a regular expression and shell text in an ID as plain text", async () => {
      const before = await fs.readdir(folder);
      for (const bundleId of [
        ".*",
        "com.example.*",
        "x' ; touch pwned ; '",
        'x" ; touch pwned ; "',
        "$(touch pwned)",
      ]) {
        await run(bundleId);
      }
      expect((await fs.readdir(folder)).sort()).toEqual(before.sort());
      await expect(fs.stat(path.join(home, "pwned"))).rejects.toThrow();
    });
  },
);
