import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stampAppChannel } from "./channelInfoPlist";
import { readBuiltApp } from "./readBuiltApp";

let root: string;

const writePlist = async (file: string, value: Record<string, unknown>) => {
  await fs.writeFile(file, JSON.stringify(value));
  execFileSync("plutil", ["-convert", "xml1", file]);
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "channel-plist-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("stampAppChannel", () => {
  it("makes an app an Expo config plugin built for production report the channel", async () => {
    const app = path.join(root, "App.app");
    await fs.mkdir(app);
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      CFBundleShortVersionString: "1.0.0",
      CFBundleVersion: "1",
      HOT_UPDATER_CHANNEL: "production",
    });

    await stampAppChannel(app, "pr-7");

    expect((await readBuiltApp(app)).channel).toBe("pr-7");
  });

  it("adds the channel to an app with none, and signs a simulator app again", async () => {
    const app = path.join(root, "Sim.app");
    await fs.mkdir(app);
    await fs.copyFile("/usr/bin/true", path.join(app, "Sim"));
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleExecutable: "Sim",
      CFBundleIdentifier: "com.example.App",
    });
    execFileSync("codesign", ["--force", "--sign", "-", app]);

    await stampAppChannel(app, "pr-7", { signAdHoc: true });

    expect((await readBuiltApp(app)).channel).toBe("pr-7");
    execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
  });
});
