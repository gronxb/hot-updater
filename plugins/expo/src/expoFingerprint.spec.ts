import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isHotUpdaterPlugin,
  reactNativeConfigCommands,
  readExpoSettings,
} from "./expoFingerprint";

let project: string;

const writePackage = async (
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(manifest));
  for (const [file, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), contents);
  }
};

beforeEach(async () => {
  project = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-expo-fp-")),
  );
  await writePackage(
    path.join(project, "node_modules/expo-build-properties"),
    { name: "expo-build-properties", version: "0.13.2", main: "index.js" },
    { "index.js": "module.exports = (config) => config;" },
  );
  await writePackage(
    path.join(project, "node_modules/@hot-updater/expo"),
    { name: "@hot-updater/expo", version: "1.0.0" },
    { "app.plugin.js": "module.exports = (config) => config;" },
  );
  await fs.mkdir(path.join(project, "plugins"));
  await fs.writeFile(
    path.join(project, "plugins/withLocal.js"),
    "module.exports = (config) => config;",
  );
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

const load = (file: string) =>
  createRequire(path.join(project, "package.json"))(file) as Function;

// The settings of the config plugins alone.
const pluginSettings = (...args: Parameters<typeof readExpoSettings>) =>
  Object.fromEntries(
    Object.entries(readExpoSettings(...args)).filter(([key]) =>
      key.startsWith("expo.plugin"),
    ),
  );

describe("readExpoSettings", () => {
  it("reads the engine, the architecture, and the config plugins the app declares", () => {
    const settings = readExpoSettings(
      project,
      {
        jsEngine: "hermes",
        newArchEnabled: true,
        android: { jsEngine: "jsc" },
        plugins: [
          ["@hot-updater/expo", { channel: "production" }],
          ["expo-build-properties", { ios: { deploymentTarget: "15.1" } }],
          "./plugins/withLocal",
        ],
      },
      "android",
    );

    expect(
      Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [
          key,
          key.startsWith("expo.plugin") ? JSON.parse(value) : value,
        ]),
      ),
    ).toEqual({
      "expo.jsEngine": "jsc",
      "expo.newArchEnabled": "true",
      "expo.plugin[0]:expo-build-properties": {
        // Options are recorded by hash, since they can hold credentials.
        props: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        source: "expo-build-properties@0.13.2",
      },
      "expo.plugin[1]:plugins/withLocal.js": { props: null, source: "local" },
    });
  });

  it("changes with a plugin's options, not with their key order", () => {
    const read = (props: object) =>
      pluginSettings(
        project,
        { plugins: [["expo-build-properties", props]] },
        "ios",
      );
    const before = read({ a: 1, b: 2 });

    expect(read({ b: 2, a: 1 })).toEqual(before);
    expect(read({ a: 1, b: 3 })).not.toEqual(before);
  });

  it("tells apart options JSON would drop or flatten", () => {
    const read = (props: object) =>
      pluginSettings(
        project,
        { plugins: [["expo-build-properties", props]] },
        "ios",
      );
    const distinct = [
      {},
      { a: undefined },
      { a: () => 1 },
      { a: () => 2 },
      { a: new Date(0) },
      { a: new Date(1) },
      { a: /x/u },
      { a: /y/u },
      { a: 1n },
      { a: new Map([["k", 1]]) },
      { a: new Set([1]) },
    ].map((props) => JSON.stringify(read(props)));

    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("counts a registry plugin by its version", async () => {
    const read = () =>
      pluginSettings(project, { plugins: ["expo-build-properties"] }, "ios");
    const before = read();

    await writePackage(
      path.join(project, "node_modules/expo-build-properties"),
      { name: "expo-build-properties", version: "0.14.0", main: "index.js" },
    );
    expect(read()).not.toEqual(before);
  });

  it("counts a local plugin by its name, not its code, like a bare app's native projects", async () => {
    const read = (plugins: unknown[]) =>
      pluginSettings(project, { plugins }, "ios");
    const before = read(["./plugins/withLocal"]);

    await fs.writeFile(
      path.join(project, "plugins/withLocal.js"),
      "module.exports = (config) => ({ ...config, name: 'x' });",
    );
    expect(read(["./plugins/withLocal"])).toEqual(before);
    // Adding or removing it still counts.
    expect(read([])).not.toEqual(before);
  });

  it("names a plugin the same however the app config refers to it", () => {
    const read = (plugin: unknown) =>
      pluginSettings(project, { plugins: [plugin] }, "ios");
    const local = read("./plugins/withLocal");

    expect(read("./plugins/withLocal.js")).toEqual(local);
    expect(read(path.join(project, "plugins/withLocal.js"))).toEqual(local);
    expect(read(load("./plugins/withLocal"))).toEqual(local);
    // A registry plugin passed as a function or a resolved path counts by its
    // package and version.
    expect(
      read(load(path.join(project, "node_modules/expo-build-properties"))),
    ).toEqual({
      "expo.plugin[0]:expo-build-properties/index.js": JSON.stringify({
        props: null,
        source: "expo-build-properties@0.13.2",
      }),
    });
  });

  it("counts a registry plugin passed as a named export by its version and export", async () => {
    await fs.writeFile(
      path.join(project, "node_modules/expo-build-properties/index.js"),
      "exports.withNative = (config) => config; exports.withOther = (config) => config;",
    );
    const { withNative, withOther } = load(
      path.join(project, "node_modules/expo-build-properties"),
    ) as unknown as { withNative: Function; withOther: Function };
    const read = (plugin: Function) =>
      pluginSettings(project, { plugins: [plugin] }, "ios");

    expect(read(withNative)).toEqual({
      "expo.plugin[0]:expo-build-properties/index.js#withNative":
        JSON.stringify({
          props: null,
          source: "expo-build-properties@0.13.2",
        }),
    });
    // Another plugin from the same package is another plugin.
    expect(read(withOther)).not.toEqual(read(withNative));
  });

  it("counts a registry plugin a local barrel re-exports by its package", async () => {
    await fs.writeFile(
      path.join(project, "plugins/barrel.js"),
      "module.exports = require('expo-build-properties');",
    );
    const read = () =>
      pluginSettings(project, { plugins: [load("./plugins/barrel")] }, "ios");

    expect(read()).toEqual({
      "expo.plugin[0]:expo-build-properties/index.js": JSON.stringify({
        props: null,
        source: "expo-build-properties@0.13.2",
      }),
    });
    // So is Hot Updater's own plugin, which is left out.
    await fs.writeFile(
      path.join(project, "plugins/hotUpdaterBarrel.js"),
      "module.exports = require('@hot-updater/expo/app.plugin.js');",
    );
    expect(
      isHotUpdaterPlugin(project, load("./plugins/hotUpdaterBarrel")),
    ).toBe(true);
  });

  it("counts an aliased registry plugin by the package it installs", async () => {
    await writePackage(path.join(project, "node_modules/native-plugin"), {
      name: "expo-build-properties",
      version: "0.13.2",
    });

    expect(
      pluginSettings(project, { plugins: ["native-plugin"] }, "ios"),
    ).toEqual({
      "expo.plugin[0]:native-plugin": JSON.stringify({
        props: null,
        source: "expo-build-properties@0.13.2",
      }),
    });
  });

  it("counts a workspace plugin package by its name", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-expo-ws-")),
    );
    try {
      await writePackage(
        workspace,
        { name: "@acme/plugin", version: "1.0.0" },
        { "app.plugin.js": "module.exports = (config) => config;" },
      );
      await fs.mkdir(path.join(project, "node_modules/@acme"));
      await fs.symlink(
        workspace,
        path.join(project, "node_modules/@acme/plugin"),
      );

      expect(
        pluginSettings(project, { plugins: ["@acme/plugin"] }, "ios"),
      ).toEqual({
        "expo.plugin[0]:@acme/plugin": JSON.stringify({
          props: null,
          source: "workspace",
        }),
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("names an inline plugin by its function name", () => {
    const withInline = (config: unknown) => config;

    expect(pluginSettings(project, { plugins: [withInline] }, "ios")).toEqual({
      "expo.plugin[0]:withInline": JSON.stringify({
        props: null,
        source: "inline",
      }),
    });
  });

  it("numbers plugins without Hot Updater's own, so moving it changes nothing", () => {
    const read = (plugins: unknown[]) =>
      pluginSettings(project, { plugins }, "ios");
    const hotUpdater = ["@hot-updater/expo", { channel: "production" }];

    expect(read([hotUpdater, "expo-build-properties"])).toEqual(
      read(["expo-build-properties", hotUpdater]),
    );
  });

  it("leaves out what the app config doesn't declare", () => {
    // Expo builds with Hermes unless the app config says otherwise.
    expect(readExpoSettings(project, {}, "ios")).toEqual({
      "expo.jsEngine": "hermes",
    });
  });
});

describe("isHotUpdaterPlugin", () => {
  it("recognizes Hot Updater's plugin in every form an app config names it", () => {
    const appPlugin = path.join(
      project,
      "node_modules/@hot-updater/expo/app.plugin.js",
    );

    expect(isHotUpdaterPlugin(project, "@hot-updater/expo")).toBe(true);
    expect(isHotUpdaterPlugin(project, "@hot-updater/expo/app.plugin")).toBe(
      true,
    );
    expect(isHotUpdaterPlugin(project, appPlugin)).toBe(true);
    expect(isHotUpdaterPlugin(project, load(appPlugin))).toBe(true);
    expect(isHotUpdaterPlugin(project, "expo-build-properties")).toBe(false);
    expect(isHotUpdaterPlugin(project, "./plugins/withLocal")).toBe(false);
  });
});

describe("reactNativeConfigCommands", () => {
  it("lists React Native packages with Expo's autolinking, then React Native CLI", () => {
    expect(reactNativeConfigCommands(project, "ios", {})).toHaveLength(2);
  });

  it("uses React Native CLI alone when EXPO_USE_COMMUNITY_AUTOLINKING=1", async () => {
    await writePackage(path.join(project, "node_modules/react-native"), {
      name: "react-native",
      version: "0.76.0",
    });
    const commands = reactNativeConfigCommands(project, "ios", {
      EXPO_USE_COMMUNITY_AUTOLINKING: "1",
    });

    expect(commands.map((command) => command())).toEqual([
      [path.join(project, "node_modules/react-native/cli.js"), "config"],
    ]);
  });
});
