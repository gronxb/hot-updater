import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lynx } from "@hot-updater/lynx-build";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AndroidConfigParser } from "../src/utils/configParser/androidParser";
import { IosConfigParser } from "../src/utils/configParser/iosParser";

describe("Lynx fingerprint native injection", () => {
  let cwd: string;
  let manifest: string;
  let plist: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-first-fingerprint-"));
    manifest = path.join(cwd, "android/app/src/main/AndroidManifest.xml");
    plist = path.join(cwd, "ios/Info.plist");
    const sdk = path.join(cwd, "node_modules/@hot-updater/lynx");
    const sparkling = path.join(
      cwd,
      "node_modules/@hot-updater/lynx-sparkling",
    );
    await Promise.all([
      fs.mkdir(path.dirname(manifest), { recursive: true }),
      fs.mkdir(path.dirname(plist), { recursive: true }),
      fs.mkdir(sdk, { recursive: true }),
      fs.mkdir(sparkling, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(sdk, "package.json"), "{}"),
      fs.writeFile(path.join(sparkling, "package.json"), "{}"),
      fs.writeFile(path.join(cwd, "package.json"), "{}"),
      fs.writeFile(
        manifest,
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET">\n</uses-permission><application android:label="App"><activity android:name=".MainActivity" /></application></manifest>',
      ),
      fs.writeFile(
        plist,
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>App</string><key>NativeData</key><data>\n  AQI=\n</data><key>EmptyData</key><data>\n</data></dict></plist>',
      ),
    ]);
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it.each(["ios", "android"] as const)(
    "keeps the first %s fingerprint valid after the CLI embeds it",
    async (platform) => {
      const adapter = lynx({
        build: async () => {
          throw new Error("Fingerprinting must not run the compiler");
        },
      })({ cwd });
      const fingerprint = (target: "ios" | "android") =>
        adapter.nativeBuild!.fingerprint!({ platform: target });
      const other = platform === "ios" ? "android" : "ios";
      const before = await fingerprint(platform);
      const otherBefore = await fingerprint(other);
      const parser =
        platform === "ios"
          ? new IosConfigParser([plist])
          : new AndroidConfigParser([manifest]);
      const key =
        platform === "ios"
          ? "HOT_UPDATER_FINGERPRINT_HASH"
          : "com.hotupdater.FINGERPRINT_HASH";

      expect((await parser.get(key)).value).toBeNull();
      await parser.set(key, before.hash);
      expect((await parser.get(key)).value).toBe(before.hash);
      expect(await fingerprint(platform)).toEqual(before);

      await parser.set(key, "replacement-fingerprint");
      expect(await fingerprint(platform)).toEqual(before);

      const nativeFile = platform === "ios" ? plist : manifest;
      const contents = await fs.readFile(nativeFile, "utf8");
      await fs.writeFile(
        nativeFile,
        platform === "ios"
          ? contents.replace("<string>App</string>", "<string>Changed</string>")
          : contents.replace('android:label="App"', 'android:label="Changed"'),
      );
      expect((await fingerprint(platform)).hash).not.toBe(before.hash);
      expect(await fingerprint(other)).toEqual(otherBefore);
    },
  );
});
