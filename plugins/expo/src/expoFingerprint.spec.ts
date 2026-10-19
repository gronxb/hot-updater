import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reactNativeConfigCommand, readExpoSettings } from "./expoFingerprint";

describe("readExpoSettings", () => {
  it("reads the engine and the architecture, with per-platform overrides", () => {
    const exp = {
      jsEngine: "hermes",
      newArchEnabled: true,
      android: { jsEngine: "jsc", newArchEnabled: false },
    };

    expect(readExpoSettings(exp, "android")).toEqual({
      "expo.jsEngine": "jsc",
      "expo.newArchEnabled": "false",
    });
    expect(readExpoSettings(exp, "ios")).toEqual({
      "expo.jsEngine": "hermes",
      "expo.newArchEnabled": "true",
    });
  });

  it("counts Hermes when the app config leaves the engine out, as Expo builds", () => {
    expect(readExpoSettings({}, "ios")).toEqual(
      readExpoSettings({ jsEngine: "hermes" }, "ios"),
    );
  });

  it("reads nothing else from the app config", () => {
    expect(
      readExpoSettings(
        {
          version: "9.9.9",
          ios: { buildNumber: "42" },
          plugins: [["expo-build-properties", { ios: {} }]],
        } as never,
        "ios",
      ),
    ).toEqual({ "expo.jsEngine": "hermes" });
  });
});

describe("reactNativeConfigCommand", () => {
  let project: string;

  const writeManifest = async (name: string, version: string) => {
    const dir = path.join(project, "node_modules", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version }),
    );
  };

  beforeEach(async () => {
    project = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-expo-fp-")),
    );
    await writeManifest("react-native", "0.76.0");
    await writeManifest("expo", "52.0.0");
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  const reactNativeCli = () => [
    path.join(project, "node_modules/react-native/cli.js"),
    "config",
  ];

  it("lists React Native packages with Expo's autolinking from 1.12", async () => {
    await writeManifest("expo-modules-autolinking", "2.0.8");

    expect(reactNativeConfigCommand(project, "ios", {})).toEqual([
      path.join(
        project,
        "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
      ),
      "react-native-config",
      "--platform",
      "ios",
      "--json",
    ]);
  });

  it("uses React Native CLI before 1.12, such as SDK 50", async () => {
    await writeManifest("expo-modules-autolinking", "1.10.3");

    expect(reactNativeConfigCommand(project, "ios", {})).toEqual(
      reactNativeCli(),
    );
  });

  it("uses React Native CLI when EXPO_USE_COMMUNITY_AUTOLINKING=1", async () => {
    await writeManifest("expo-modules-autolinking", "2.0.8");

    expect(
      reactNativeConfigCommand(project, "ios", {
        EXPO_USE_COMMUNITY_AUTOLINKING: "1",
      }),
    ).toEqual(reactNativeCli());
  });
});
