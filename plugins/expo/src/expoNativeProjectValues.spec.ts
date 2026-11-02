import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { expo, getExpoNativeProjectValues } from "./expo";

const packageRoot = path.resolve(__dirname, "..");
const tempDirs: string[] = [];

/**
 * An Expo project with the real `expo` package and this config plugin,
 * whose `ios/` and `android/` an earlier prebuild wrote from another
 * environment.
 */
const createProject = async (expoConfig: Record<string, unknown>) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "expo-native-values-"));
  tempDirs.push(cwd);
  await fs.mkdir(path.join(cwd, "node_modules/@hot-updater"), {
    recursive: true,
  });
  await fs.symlink(
    await fs.realpath(path.join(packageRoot, "node_modules/expo")),
    path.join(cwd, "node_modules/expo"),
  );
  await fs.symlink(
    packageRoot,
    path.join(cwd, "node_modules/@hot-updater/expo"),
  );
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "app", version: "0.0.1" }),
  );
  await fs.writeFile(
    path.join(cwd, "app.json"),
    JSON.stringify({ expo: { name: "app", slug: "app", ...expoConfig } }),
  );
  await fs.mkdir(path.join(cwd, "ios/app"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "ios/app/Info.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key><string>1.0.0</string><key>HOT_UPDATER_CHANNEL</key><string>production</string></dict></plist>",
  );
  await fs.mkdir(path.join(cwd, "android/app"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "android/app/build.gradle"),
    'android { defaultConfig { versionName "1.0.0" } }',
  );
  return cwd;
};

/** Every file of the project outside node_modules, with its content's hash. */
const hashTree = async (dir: string) => {
  const tree: Record<string, string> = {};
  const entries = await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    const file = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || file.includes(`${path.sep}node_modules`)) continue;
    tree[path.relative(dir, file)] = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  }
  return tree;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("getExpoNativeProjectValues", () => {
  it("reads the version and channel prebuild would write, without writing the native projects", async () => {
    const cwd = await createProject({
      version: "3.4.5",
      ios: { version: "3.4.6" },
      plugins: [["@hot-updater/expo", { channel: "qa" }]],
    });
    const before = await hashTree(cwd);

    // The project's own Expo SDK decides: SDK 50, this package's, writes
    // `version` for iOS, where later SDKs prefer `ios.version`.
    await expect(getExpoNativeProjectValues(cwd, "ios")).resolves.toEqual({
      appVersion: "3.4.5",
      channel: "qa",
    });
    await expect(
      expo()({ cwd }).nativeBuild?.getNativeProjectValues?.({
        platform: "android",
      }),
    ).resolves.toEqual({ appVersion: "3.4.5", channel: "qa" });
    expect(await hashTree(cwd)).toEqual(before);
  });

  it("reports the config plugin's default channel when it sets none", async () => {
    const cwd = await createProject({
      version: "2.0.0",
      plugins: ["@hot-updater/expo"],
    });

    await expect(getExpoNativeProjectValues(cwd, "ios")).resolves.toEqual({
      appVersion: "2.0.0",
      channel: "production",
    });
  });

  it("leaves the channel to the native project without the config plugin", async () => {
    const cwd = await createProject({ version: "2.0.0" });

    await expect(getExpoNativeProjectValues(cwd, "android")).resolves.toEqual({
      appVersion: "2.0.0",
    });
  });
});
