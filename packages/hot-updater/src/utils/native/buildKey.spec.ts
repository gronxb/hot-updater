import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { maskSecretValues, registerSecretValue } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalXcodeProject,
  computeNativeBuildKey,
  diffNativeBuildKeyComponents,
  type NativeBuildKeyComponents,
  type NativeBuildKeyInput,
} from "./buildKey";

let root: string;
let app: string;
let gradleHome: string;
let toolchain: Record<string, string>;

const write = (file: string, contents: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });

const input = (
  overrides: Partial<NativeBuildKeyInput> = {},
): NativeBuildKeyInput => ({
  cwd: app,
  platform: "android",
  scheme: "release",
  schemeConfig: { variant: "Release", aab: false, packageName: "com.app" },
  artifactKind: "apk",
  channel: "production",
  fingerprintHash: null,
  appVersion: "1.0.0",
  outputPath: path.join(app, ".hot-updater", "output", "build"),
  cacheDir: path.join(app, "node_modules", ".hot-updater"),
  signing: {},
  hotUpdaterVersion: "1.2.0",
  buildAdapter: "bare",
  env: { GRADLE_USER_HOME: gradleHome },
  readToolchain: async () => toolchain,
  ...overrides,
});

const key = async (overrides: Partial<NativeBuildKeyInput> = {}) => {
  const result = await computeNativeBuildKey(input(overrides));
  if (result.key === null) {
    throw new Error(`uncacheable: ${result.uncacheable}`);
  }
  return result;
};

const uncacheable = async (overrides: Partial<NativeBuildKeyInput> = {}) =>
  (await computeNativeBuildKey(input(overrides))).uncacheable;

/**
 * An Xcode project with one target building `files` in order, its objects
 * named by `id` (24 hex digits, as Xcode and CocoaPods write them).
 */
const xcodeProject = (id: (name: string) => string, files: string[]) => {
  const object = (name: string, body: string) => `\t\t${id(name)} = {${body}};`;
  return [
    "// !$*UTF8*$!",
    "{",
    "\tarchiveVersion = 1;",
    "\tclasses = {",
    "\t};",
    "\tobjectVersion = 54;",
    "\tobjects = {",
    ...files.flatMap((file) => [
      object(
        `build:${file}`,
        `isa = PBXBuildFile; fileRef = ${id(`ref:${file}`)}; `,
      ),
      object(
        `ref:${file}`,
        `isa = PBXFileReference; path = ${file}; sourceTree = "<group>"; `,
      ),
    ]),
    object(
      "sources",
      `isa = PBXSourcesBuildPhase; files = (${files.map((file) => `${id(`build:${file}`)}, `).join("")}); `,
    ),
    object(
      "group",
      `isa = PBXGroup; children = (${files.map((file) => `${id(`ref:${file}`)}, `).join("")}); sourceTree = "<group>"; `,
    ),
    object(
      "target",
      `isa = PBXNativeTarget; buildPhases = (${id("sources")}, ); name = App; `,
    ),
    object(
      "project",
      `isa = PBXProject; attributes = {TargetAttributes = {${id("target")} = {CreatedOnToolsVersion = 16.0; }; }; }; mainGroup = ${id("group")}; targets = (${id("target")}, ); `,
    ),
    "\t};",
    `\trootObject = ${id("project")};`,
    "}",
    "",
  ].join("\n");
};

/** Object IDs as `pod install` writes them: new random ones each time. */
const randomIds = () => {
  const ids = new Map<string, string>();
  return (name: string) => {
    if (!ids.has(name)) {
      ids.set(
        name,
        Array.from({ length: 24 }, () =>
          "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16)),
        ).join(""),
      );
    }
    return ids.get(name)!;
  };
};

/**
 * What autolinking links, as React Native CLI's `config` prints it: the
 * fake CLI the fixture installs prints this file.
 */
const link = (dependencies: Record<string, unknown>) =>
  write(
    "apps/mobile/node_modules/react-native/config.json",
    JSON.stringify({
      root: app,
      reactNativePath: path.join(app, "node_modules/react-native"),
      dependencies,
      project: {
        ios: { sourceDir: path.join(app, "ios") },
        android: { sourceDir: path.join(app, "android") },
      },
    }),
  );

/** A dependency as React Native CLI's `config` lists it. */
const linked = (
  name: string,
  dir: string,
  platforms: Record<string, unknown> = { ios: {}, android: {} },
) => ({ [name]: { name, root: path.join(root, dir), platforms } });

/** What changed between the key before and after `change`. */
const changedBy = async (
  change: () => void | Promise<void>,
  overrides: Partial<NativeBuildKeyInput> = {},
  after: Partial<NativeBuildKeyInput> = overrides,
) => {
  const before = await key(overrides);
  await change();
  const next = await key(after);
  return {
    changed: diffNativeBuildKeyComponents(before.components, next.components),
    same: before.key === next.key,
  };
};

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-build-key-")),
  );
  app = path.join(root, "apps", "mobile");
  // The machine's Gradle home, outside the repository.
  gradleHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-build-key-gradle-")),
  );
  toolchain = { jdk: "17.0.1", "android-sdk:build-tools": "36.0.0" };
  write(
    ".gitignore",
    [
      "node_modules/",
      ".env*",
      "build/",
      "local.properties",
      ".xcode.env.local",
      "GoogleService-Info.plist",
      ".hot-updater/",
      "lib/",
      "vendor/",
      "",
    ].join("\n"),
  );
  write(
    "apps/mobile/package.json",
    JSON.stringify({
      name: "mobile",
      dependencies: { "native-lib": "1.0.0", "js-lib": "1.0.0" },
    }),
  );
  write("apps/mobile/src/App.tsx", "export const App = () => null;\n");
  write(
    "apps/mobile/android/app/build.gradle",
    [
      "def jscFlavor = 'io.github.react-native-community:jsc-android:2026004.+'",
      'def flavor = System.getenv("APP_FLAVOR")',
      'dependencies { implementation("com.facebook.react:react-android") }',
      "",
    ].join("\n"),
  );
  write("apps/mobile/ios/Podfile", "platform :ios, '15.1'\n");
  write("apps/mobile/ios/Podfile.lock", "PODS:\n  - React (0.88.0)\n");
  write("docs/README.md", "# Docs\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init");
  // Installed after the commit: git ignores node_modules.
  write(
    "apps/mobile/node_modules/native-lib/package.json",
    JSON.stringify({ name: "native-lib", version: "1.0.0" }),
  );
  write("apps/mobile/node_modules/native-lib/android/build.gradle", "\n");
  write(
    "apps/mobile/node_modules/native-lib/android/src/Lib.kt",
    "class Lib\n",
  );
  write("apps/mobile/node_modules/native-lib/ios/Lib.m", "// lib\n");
  write("apps/mobile/node_modules/native-lib/native-lib.podspec", "\n");
  write(
    "apps/mobile/node_modules/js-lib/package.json",
    JSON.stringify({ name: "js-lib", version: "1.0.0" }),
  );
  write("apps/mobile/node_modules/js-lib/index.js", "module.exports = 1;\n");
  write("apps/mobile/node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.0'\n");
  // React Native CLI, whose `config` prints what autolinking links.
  write(
    "apps/mobile/node_modules/react-native/package.json",
    JSON.stringify({ name: "react-native", version: "0.88.0" }),
  );
  write(
    "apps/mobile/node_modules/react-native/cli.js",
    'const fs = require("fs"); const path = require("path"); process.stdout.write(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));\n',
  );
  link({
    ...linked("native-lib", "apps/mobile/node_modules/native-lib", {
      ios: {
        podspecPath: path.join(
          root,
          "apps/mobile/node_modules/native-lib/native-lib.podspec",
        ),
      },
      android: {
        sourceDir: path.join(
          root,
          "apps/mobile/node_modules/native-lib/android",
        ),
      },
    }),
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(gradleHome, { recursive: true, force: true });
});

describe("computeNativeBuildKey", () => {
  it("computes the same key from the same inputs, with and without its hash cache", async () => {
    const first = await key();
    const second = await key();
    const uncached = await key({ cacheDir: null });

    expect(first.key).toMatch(/^nbk1:[0-9a-f]{64}$/);
    expect(second.key).toBe(first.key);
    expect(uncached.key).toBe(first.key);
  });

  it("changes with a file of the repository, whether it is staged or not", async () => {
    const edit = await changedBy(() =>
      write("apps/mobile/src/App.tsx", "export const App = () => 1;\n"),
    );
    expect(edit.changed).toEqual(["file:apps/mobile/src/App.tsx"]);

    const unstaged = await key();
    git("add", "apps/mobile/src/App.tsx");
    expect((await key()).key).toBe(unstaged.key);

    // Every file of the repository, as a commit records it.
    expect(
      (await changedBy(() => write("docs/README.md", "# Changed\n"))).changed,
    ).toEqual(["file:docs/README.md"]);
    expect(
      (await changedBy(() => write("apps/mobile/src/New.tsx", "1;\n"))).changed,
    ).toEqual(["file:apps/mobile/src/New.tsx"]);
    expect(
      (await changedBy(() => fs.rmSync(path.join(root, "docs/README.md"))))
        .changed,
    ).toEqual(["file:docs/README.md"]);
  });

  it("does not change when a file is only touched, or the CLI writes its output", async () => {
    const touched = await changedBy(() => {
      const file = path.join(app, "src/App.tsx");
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
    });
    expect(touched).toEqual({ changed: [], same: true });

    const output = await changedBy(() => {
      write("apps/mobile/.hot-updater/output/build/app.apk", "apk");
      write("apps/mobile/node_modules/.hot-updater/other.json", "{}");
      write("apps/mobile/node_modules/native-lib/android/build/out.o", "o");
      write("apps/mobile/android/app/build/outputs/app.apk", "apk");
      write("apps/mobile/android/.gradle/state.bin", "s");
      write("apps/mobile/.DS_Store", "finder");
    });
    expect(output).toEqual({ changed: [], same: true });
  });

  it("changes with an input git ignores: native project files, .env files, the install state, and installed native packages", async () => {
    expect(
      (
        await changedBy(() =>
          write("apps/mobile/node_modules/native-lib/android/src/Lib.kt", "x"),
        )
      ).changed,
    ).toEqual(["input:package:native-lib@1.0.0"]);
    expect(
      (
        await changedBy(() =>
          write("apps/mobile/node_modules/.pnpm/lock.yaml", "changed: 1\n"),
        )
      ).changed,
    ).toEqual(["input:install-state:apps/mobile/node_modules/.pnpm/lock.yaml"]);
    expect(
      (await changedBy(() => write("apps/mobile/.env", "API_URL=https://a\n")))
        .changed,
    ).toEqual(["input:env-file:apps/mobile/.env"]);
    expect(
      (
        await changedBy(() =>
          write("apps/mobile/android/local.properties", "flipper=true\n"),
        )
      ).changed,
    ).toEqual(["input:local.properties"]);
    // A quoted .env value's later lines, and a properties value a
    // backslash continues.
    write("apps/mobile/.env", 'EXPO_PUBLIC_MESSAGE="first\nold"\n');
    write("apps/mobile/android/local.properties", "flags=a,\\\n  old\n");
    expect(
      (
        await changedBy(() => {
          write("apps/mobile/.env", 'EXPO_PUBLIC_MESSAGE="first\nnew"\n');
          write("apps/mobile/android/local.properties", "flags=a,\\\n  new\n");
        })
      ).changed,
    ).toEqual(["input:env-file:apps/mobile/.env", "input:local.properties"]);
    // A JavaScript-only package is a version in the lockfile, and an iOS
    // source of a native package doesn't reach an Android build.
    expect(
      await changedBy(() => {
        write("apps/mobile/node_modules/js-lib/index.js", "2;\n");
        write("apps/mobile/node_modules/native-lib/ios/Lib.m", "// 2\n");
      }),
    ).toEqual({ changed: [], same: true });
  });

  it("changes with an iOS project's ignored files and native packages", async () => {
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(
      (
        await changedBy(
          () =>
            write("apps/mobile/ios/App/GoogleService-Info.plist", "<plist/>"),
          ios,
        )
      ).changed,
    ).toEqual(["input:file:apps/mobile/ios/App/GoogleService-Info.plist"]);
    // This machine's Node.js path, which pod install writes, but the
    // file's other settings.
    expect(
      await changedBy(
        () =>
          write(
            "apps/mobile/ios/.xcode.env.local",
            "export NODE_BINARY=/Users/me/.nvm/node\n",
          ),
        ios,
      ),
    ).toEqual({ changed: [], same: true });
    expect(
      (
        await changedBy(
          () =>
            write(
              "apps/mobile/ios/.xcode.env.local",
              "export NODE_BINARY=/Users/me/.nvm/node\nexport ENTRY_FILE=index.ios.js\n",
            ),
          ios,
        )
      ).changed,
    ).toEqual(["input:.xcode.env.local"]);
    expect(
      (
        await changedBy(
          () => write("apps/mobile/node_modules/native-lib/ios/Lib.m", "// 3"),
          ios,
        )
      ).changed,
    ).toEqual(["input:package:native-lib@1.0.0"]);
  });

  it("changes with the ignored files of a package of the repository, but not with what builds write", async () => {
    // A workspace package, linked into node_modules as pnpm links it.
    write(
      "packages/native-ws/package.json",
      JSON.stringify({
        name: "native-ws",
        version: "1.0.0",
        main: "lib/index.js",
      }),
    );
    write("packages/native-ws/ios/Ws.m", "// ws\n");
    write("packages/native-ws/lib/index.js", "module.exports = 1;\n");
    write("packages/native-ws/android/lib/generated.kt", "class A\n");
    write(
      "apps/mobile/package.json",
      JSON.stringify({
        name: "mobile",
        dependencies: {
          "native-lib": "1.0.0",
          "js-lib": "1.0.0",
          "native-ws": "workspace:*",
        },
      }),
    );
    fs.symlinkSync(
      path.join(root, "packages/native-ws"),
      path.join(app, "node_modules/native-ws"),
    );
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };

    // The built lib/ its entry points at, which git ignores.
    expect(
      (
        await changedBy(
          () =>
            write("packages/native-ws/lib/index.js", "module.exports = 2;\n"),
          ios,
        )
      ).changed,
    ).toEqual(["input:package:native-ws@1.0.0"]);
    // Generated sources, also ignored.
    expect(
      (
        await changedBy(
          () => write("packages/native-ws/lib/nitrogen/Spec.swift", "// 1\n"),
          ios,
        )
      ).changed,
    ).toEqual(["input:package:native-ws@1.0.0"]);
    // A tracked file counts as a file of the repository.
    expect(
      (
        await changedBy(
          () => write("packages/native-ws/ios/Ws.m", "// 2\n"),
          ios,
        )
      ).changed,
    ).toEqual(["file:packages/native-ws/ios/Ws.m"]);
    // What builds write, and the other platform's folder.
    expect(
      await changedBy(() => {
        write("packages/native-ws/build/out.o", "o");
        write("packages/native-ws/ios/build/Build.o", "o");
        write("packages/native-ws/node_modules/dep/index.js", "1;\n");
        write("packages/native-ws/android/lib/generated.kt", "class B\n");
      }, ios),
    ).toEqual({ changed: [], same: true });
  });

  it("changes with a package only autolinking links, wherever it is", async () => {
    // Outside the dependency walk, in a folder git ignores, as an Expo
    // `searchPaths` or a react-native.config.js `root` finds it.
    write(
      "vendor/extra-native/package.json",
      JSON.stringify({ name: "extra-native", version: "2.0.0" }),
    );
    write("vendor/extra-native/ios/Extra.m", "// 1\n");
    write("vendor/extra-native/extra-native.podspec", "\n");
    // Outside the repository.
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "native-build-key-outside-")),
    );
    fs.mkdirSync(path.join(outside, "ios"));
    fs.writeFileSync(
      path.join(outside, "package.json"),
      JSON.stringify({ name: "outside-native", version: "3.0.0" }),
    );
    fs.writeFileSync(path.join(outside, "ios/Outside.m"), "// 1\n");
    link({
      ...linked("extra-native", "vendor/extra-native"),
      "outside-native": {
        name: "outside-native",
        root: outside,
        platforms: { ios: {} },
      },
    });
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    try {
      expect(
        (
          await changedBy(
            () => write("vendor/extra-native/ios/Extra.m", "// 2\n"),
            ios,
          )
        ).changed,
      ).toEqual(["input:package:extra-native@2.0.0"]);
      expect(
        (
          await changedBy(
            () =>
              fs.writeFileSync(path.join(outside, "ios/Outside.m"), "// 2\n"),
            ios,
          )
        ).changed,
      ).toEqual(["input:package:outside-native@3.0.0"]);
      expect(
        await changedBy(() => {
          write("vendor/extra-native/build/out.o", "o");
          write("vendor/extra-native/ios/Pods/Manifest.lock", "x");
          fs.mkdirSync(path.join(outside, "build"));
          fs.writeFileSync(path.join(outside, "build/out.o"), "o");
        }, ios),
      ).toEqual({ changed: [], same: true });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keys a library at the repository's root, as its example app links it, by its ignored files", async () => {
    write(
      "package.json",
      JSON.stringify({ name: "the-library", version: "1.0.0" }),
    );
    write("the-library.podspec", "\n");
    link(linked("the-library", "."));
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
      // An output and a cache outside .hot-updater, which never count.
      outputPath: path.join(root, "out"),
      cacheDir: path.join(root, "cache"),
    };
    expect(
      (
        await changedBy(
          () => write("lib/index.js", "module.exports = 2;\n"),
          ios,
        )
      ).changed,
    ).toEqual(["input:package:the-library@1.0.0"]);
    expect(
      await changedBy(() => {
        write("out/App.app/App", "binary");
        write("cache/native-build/ios/entry/meta.json", "{}");
        write("build/out.o", "o");
      }, ios),
    ).toEqual({ changed: [], same: true });
  });

  it("changes with the native code a package keeps where autolinking says, not in ios/ or android/", async () => {
    // No ios/, apple/, android/, or podspec at its root: the dependency
    // walk alone takes it for JavaScript.
    write(
      "apps/mobile/node_modules/src-only/package.json",
      JSON.stringify({ name: "src-only", version: "1.0.0" }),
    );
    write("apps/mobile/node_modules/src-only/native/SrcOnly.podspec", "\n");
    write("apps/mobile/node_modules/src-only/native/SrcOnly.m", "// 1\n");
    write(
      "apps/mobile/node_modules/src-only/platform/droid/src/SrcOnly.kt",
      "class A\n",
    );
    write(
      "apps/mobile/package.json",
      JSON.stringify({
        name: "mobile",
        dependencies: { "native-lib": "1.0.0", "src-only": "1.0.0" },
      }),
    );
    const before = await key({
      platform: "ios",
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app",
    });
    expect(Object.keys(before.components.inputs)).not.toContain(
      "package:src-only@1.0.0",
    );

    link({
      ...linked("native-lib", "apps/mobile/node_modules/native-lib"),
      ...linked("src-only", "apps/mobile/node_modules/src-only", {
        ios: {
          podspecPath: path.join(
            root,
            "apps/mobile/node_modules/src-only/native/SrcOnly.podspec",
          ),
        },
        android: {
          sourceDir: path.join(
            root,
            "apps/mobile/node_modules/src-only/platform/droid",
          ),
        },
      }),
    });
    for (const [platform, file] of [
      ["ios", "native/SrcOnly.m"],
      ["android", "platform/droid/src/SrcOnly.kt"],
    ] as const) {
      const overrides =
        platform === "ios"
          ? {
              platform,
              schemeConfig: { configuration: "Release", simulator: true },
              artifactKind: "app" as const,
            }
          : {};
      expect(
        (
          await changedBy(
            () => write(`apps/mobile/node_modules/src-only/${file}`, "changed"),
            overrides,
          )
        ).changed,
      ).toEqual(["input:package:src-only@1.0.0"]);
    }
  });

  it("changes with either of two installs of one version", async () => {
    // As pnpm installs one version for two sets of peer dependencies.
    for (const variant of ["a", "b"]) {
      const dir = `apps/mobile/node_modules/.pnpm/twin@1.0.0_${variant}/node_modules/twin`;
      write(
        `${dir}/package.json`,
        JSON.stringify({ name: "twin", version: "1.0.0" }),
      );
      write(`${dir}/android/src/Twin.kt`, "class Twin\n");
    }
    link({
      ...linked("native-lib", "apps/mobile/node_modules/native-lib"),
      twin: {
        name: "twin",
        root: path.join(
          app,
          "node_modules/.pnpm/twin@1.0.0_a/node_modules/twin",
        ),
        platforms: { android: {} },
      },
      "twin-b": {
        name: "twin",
        root: path.join(
          app,
          "node_modules/.pnpm/twin@1.0.0_b/node_modules/twin",
        ),
        platforms: { android: {} },
      },
    });
    for (const variant of ["a", "b"]) {
      expect(
        (
          await changedBy(() =>
            write(
              `apps/mobile/node_modules/.pnpm/twin@1.0.0_${variant}/node_modules/twin/android/src/Twin.kt`,
              `class Twin${variant}\n`,
            ),
          )
        ).changed,
      ).toEqual(["input:package:twin@1.0.0"]);
    }
  });

  it("changes with how autolinking links, even when no file changed", async () => {
    const config = (scriptPhases: unknown[]) =>
      link(
        linked("native-lib", "apps/mobile/node_modules/native-lib", {
          ios: {
            podspecPath: path.join(
              root,
              "apps/mobile/node_modules/native-lib/native-lib.podspec",
            ),
            scriptPhases,
          },
        }),
      );
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    config([]);
    expect(
      (
        await changedBy(
          () => config([{ name: "Generate", script: "echo generate" }]),
          ios,
        )
      ).changed,
    ).toEqual(["autolinking:react-native"]);
    // A package autolinking stops linking.
    expect((await changedBy(() => link({}), ios)).changed).toEqual([
      "autolinking:react-native",
    ]);
  });

  it("reads Expo modules from expo-modules-autolinking", async () => {
    const modules = path.join(app, "node_modules");
    write(
      "apps/mobile/node_modules/expo/package.json",
      JSON.stringify({ name: "expo", version: "55.0.0" }),
    );
    write("apps/mobile/node_modules/expo/ios/Expo.m", "// expo\n");
    write(
      "apps/mobile/node_modules/expo-modules-autolinking/package.json",
      JSON.stringify({ name: "expo-modules-autolinking", version: "3.0.0" }),
    );
    // Not a dependency of the app: the dependency walk doesn't reach it.
    write(
      "apps/mobile/node_modules/expo-thing/package.json",
      JSON.stringify({ name: "expo-thing", version: "1.0.0" }),
    );
    write("apps/mobile/node_modules/expo-thing/ios/Thing.swift", "// 1\n");
    const resolve = (swiftModuleNames: string[]) =>
      write(
        "apps/mobile/node_modules/expo-modules-autolinking/resolve.json",
        JSON.stringify({
          modules: [
            {
              packageName: "expo-thing",
              packageVersion: "1.0.0",
              pods: [
                {
                  podName: "Thing",
                  podspecDir: path.join(modules, "expo-thing/ios"),
                },
              ],
              swiftModuleNames,
            },
          ],
        }),
      );
    resolve(["Thing"]);
    write(
      "apps/mobile/node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
      [
        'const fs = require("fs"); const path = require("path");',
        "const [command, , platform] = process.argv.slice(2);",
        'if (command === "resolve" && platform === "apple") process.stdout.write(fs.readFileSync(path.join(__dirname, "../resolve.json"), "utf8"));',
        'else if (command === "react-native-config") process.stdout.write(fs.readFileSync(path.join(__dirname, "../../react-native/config.json"), "utf8"));',
        "else process.exit(1);",
        "",
      ].join("\n"),
    );
    link(linked("expo", "apps/mobile/node_modules/expo"));
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
      buildAdapter: "expo",
    };

    const linkedKey = await key(ios);
    expect(Object.keys(linkedKey.components.autolinking).sort()).toEqual([
      "expo-modules",
      "react-native",
    ]);
    expect(
      (
        await changedBy(
          () =>
            write(
              "apps/mobile/node_modules/expo-thing/ios/Thing.swift",
              "// 2\n",
            ),
          ios,
        )
      ).changed,
    ).toEqual(["input:package:expo-thing@1.0.0"]);
    expect(
      (await changedBy(() => resolve(["Thing", "ThingUI"]), ios)).changed,
    ).toEqual(["autolinking:expo-modules"]);
  });

  it("computes the same key from a copy of the project in another directory", async () => {
    const copy = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "native-build-key-copy-")),
    );
    try {
      const original = await key();
      fs.cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
      // React Native CLI prints the copy's absolute paths.
      const config = path.join(
        copy,
        "apps/mobile/node_modules/react-native/config.json",
      );
      fs.writeFileSync(
        config,
        fs.readFileSync(config, "utf8").split(root).join(copy),
      );
      const copyApp = path.join(copy, "apps/mobile");
      const copied = await key({
        cwd: copyApp,
        outputPath: path.join(copyApp, ".hot-updater", "output", "build"),
        cacheDir: path.join(copyApp, "node_modules", ".hot-updater"),
      });
      expect(
        diffNativeBuildKeyComponents(original.components, copied.components),
      ).toEqual([]);
      expect(copied.key).toBe(original.key);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it("changes with the environment the build reads, and with nothing else in it", async () => {
    const env = (vars: Record<string, string>) => ({
      env: { GRADLE_USER_HOME: gradleHome, ...vars },
    });
    expect(
      (
        await changedBy(
          () => {},
          env({ EXPO_PUBLIC_API_URL: "https://a" }),
          env({ EXPO_PUBLIC_API_URL: "https://b" }),
        )
      ).changed,
    ).toEqual(["env:EXPO_PUBLIC_API_URL"]);
    // Read by name in android/app/build.gradle.
    expect(
      (
        await changedBy(
          () => {},
          env({ APP_FLAVOR: "a" }),
          env({ APP_FLAVOR: "b" }),
        )
      ).changed,
    ).toEqual(["env:APP_FLAVOR"]);
    // Gradle's project properties don't reach an iOS build.
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(
      await changedBy(
        () => {},
        { ...ios, ...env({ ORG_GRADLE_PROJECT_flavor: "a" }) },
        { ...ios, ...env({ ORG_GRADLE_PROJECT_flavor: "b" }) },
      ),
    ).toEqual({ changed: [], same: true });
    // Credentials, and a variable no build input reads.
    const credentials = (value: string) =>
      env({
        HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD: value,
        HOT_UPDATER_API_KEY: value,
        HOT_UPDATER_BUNDLE_SIGNING_KEY: value,
        HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING: value,
        HOT_UPDATER_VERCEL_DATABASE_URL: value,
        HOT_UPDATER_CONSOLE_SESSION: value,
        HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON: value,
        UNRELATED: value,
      });
    expect(
      await changedBy(() => {}, credentials("a"), credentials("b")),
    ).toEqual({ changed: [], same: true });
    // A public value the app bundles keys the build, whatever its name.
    expect(
      (
        await changedBy(
          () => {},
          env({ EXPO_PUBLIC_MAPS_API_KEY: "a" }),
          env({ EXPO_PUBLIC_MAPS_API_KEY: "b" }),
        )
      ).changed,
    ).toEqual(["env:EXPO_PUBLIC_MAPS_API_KEY"]);
  });

  it("reads the environment variables JavaScript configs and app code read by name", async () => {
    write(
      "apps/mobile/babel.config.js",
      "const { BUILD_FLAVOR, 'QUOTED_NAME': quoted, DEFAULTED = 'x' } = process.env;\nmodule.exports = { presets: [process.env?.BABEL_PRESET, process.env['BRACKETED']] };\n",
    );
    write(
      "apps/mobile/src/config.ts",
      "export const url = process.env.APP_URL;\nconsole.log(process.env);\n",
    );
    const env = (value: string) => ({
      env: {
        GRADLE_USER_HOME: gradleHome,
        BUILD_FLAVOR: value,
        QUOTED_NAME: value,
        DEFAULTED: value,
        BABEL_PRESET: value,
        BRACKETED: value,
        APP_URL: value,
      },
    });
    expect((await changedBy(() => {}, env("a"), env("b"))).changed).toEqual([
      "env:APP_URL",
      "env:BABEL_PRESET",
      "env:BRACKETED",
      "env:BUILD_FLAVOR",
      "env:DEFAULTED",
      "env:QUOTED_NAME",
    ]);
    // A config that hands the whole environment on reads names no key can
    // follow; app code that does reads nothing at build time.
    for (const read of [
      "const { ...all } = process.env;",
      "module.exports = { env: { ...process.env } };",
      "plugins(process.env);",
      "process.env[name];",
    ]) {
      write("apps/mobile/metro.config.js", `${read}\n`);
      expect(await uncacheable()).toBe(
        "metro.config.js reads environment variables by a computed name, which no key can follow",
      );
    }
  });

  it("reads the environment variables a generated native project reads", async () => {
    // As an Expo app's: android/ is generated and ignored.
    write(
      ".gitignore",
      `${fs.readFileSync(path.join(root, ".gitignore"))}apps/mobile/android/\n`,
    );
    git("rm", "-rq", "--cached", "apps/mobile/android");
    write(
      "apps/mobile/android/settings.gradle",
      'def community = System.getenv("EXPO_USE_COMMUNITY_AUTOLINKING")\n',
    );
    const env = (value: string) => ({
      env: {
        GRADLE_USER_HOME: gradleHome,
        EXPO_USE_COMMUNITY_AUTOLINKING: value,
      },
    });
    expect((await changedBy(() => {}, env("0"), env("1"))).changed).toEqual([
      "env:EXPO_USE_COMMUNITY_AUTOLINKING",
    ]);
    write(
      "apps/mobile/android/app/build.gradle",
      'dependencies { implementation("com.example:lib:+") }\n',
    );
    expect(await uncacheable()).toBe(
      "android/app/build.gradle declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build",
    );
    write("apps/mobile/android/app/build.gradle", "System.getenv(name)\n");
    expect(await uncacheable()).toBe(
      "android/app/build.gradle reads environment variables by a computed name, which no key can follow",
    );
  });

  it("changes with what the build embeds and how the scheme builds it", async () => {
    const base = await key();
    const changes = async (overrides: Partial<NativeBuildKeyInput>) =>
      diffNativeBuildKeyComponents(
        base.components,
        (await key(overrides)).components,
      );

    expect(await changes({ channel: "beta" })).toEqual(["setting:channel"]);
    expect(await changes({ appVersion: "1.0.1" })).toEqual([
      "setting:app-version",
    ]);
    expect(await changes({ fingerprintHash: "fp", appVersion: null })).toEqual([
      "setting:app-version",
      "setting:fingerprint",
    ]);
    expect(await changes({ artifactKind: "aab" })).toEqual([
      "setting:artifact",
    ]);
    expect(
      await changes({
        schemeConfig: {
          variant: "Release",
          aab: false,
          packageName: "com.app",
          appModuleName: "app2",
        },
      }),
    ).toEqual(["setting:scheme"]);
    expect(await changes({ hotUpdaterVersion: "1.2.1" })).toEqual([
      "toolchain:hot-updater",
    ]);
    toolchain = { ...toolchain, jdk: "21.0.1" };
    expect(await changes({})).toEqual(["toolchain:jdk"]);
  });

  it("changes with the Android SDK local.properties selects, by its installed components", async () => {
    const sdk = (name: string, buildTools: string) => {
      const dir = path.join(gradleHome, name);
      fs.mkdirSync(path.join(dir, "build-tools", buildTools), {
        recursive: true,
      });
      return dir;
    };
    const first = sdk("sdk-a", "35.0.0");
    const second = sdk("sdk-b", "36.0.0");
    const real = { readToolchain: undefined };
    write("apps/mobile/android/local.properties", `sdk.dir=${first}\n`);
    expect(
      (
        await changedBy(
          () =>
            write(
              "apps/mobile/android/local.properties",
              `sdk.dir=${second}\n`,
            ),
          real,
        )
      ).changed,
    ).toEqual(["toolchain:android-sdk:build-tools"]);
    expect(
      (
        await changedBy(
          () =>
            write(
              "apps/mobile/android/local.properties",
              `sdk.dir=${second}\nndk.dir=${second}/ndk/27.1.12297006\n`,
            ),
          real,
        )
      ).changed,
    ).toEqual(["toolchain:android-sdk:ndk.dir"]);
  });

  it("changes with the App Store Connect API key that signs, never with its secret", async () => {
    const device = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: false },
      artifactKind: "ipa" as const,
    };
    const signedBy = (keyId: string) => ({
      ...device,
      signing: { ascApiKey: { keyId, issuerId: "issuer" } },
    });
    expect(
      (await changedBy(() => {}, signedBy("KEY1"), signedBy("KEY2"))).changed,
    ).toEqual(["signing:asc-api-key"]);
  });

  it("changes with a file the scheme names", async () => {
    write("apps/mobile/ios/Release.xcconfig", "A = 1\n");
    write(
      "apps/mobile/ios/ExportOptions.plist",
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>method</key><string>app-store-connect</string></dict></plist>`,
    );
    const device = {
      platform: "ios" as const,
      schemeConfig: {
        configuration: "Release",
        simulator: false,
        xcconfig: "ios/Release.xcconfig",
        exportOptionsPlist: path.join(app, "ios/ExportOptions.plist"),
      },
      artifactKind: "ipa" as const,
    };
    // The xcconfig is a file of the repository too.
    expect(
      (
        await changedBy(
          () => write("apps/mobile/ios/Release.xcconfig", "A = 2\n"),
          device,
        )
      ).changed,
    ).toEqual([
      "file:apps/mobile/ios/Release.xcconfig",
      "setting:file:xcconfig",
    ]);
  });

  it("keeps secrets and this machine's directories out of the key and its components", async () => {
    const secret = "hunter2-native-build-secret";
    registerSecretValue(secret);
    write("apps/mobile/.env", `API_TOKEN=${secret}\nPUBLIC=${secret}\n`);
    write(
      "apps/mobile/android/local.properties",
      `sdk.dir=${os.homedir()}/sdk\nstorePassword=${secret}\n`,
    );
    fs.writeFileSync(
      path.join(gradleHome, "gradle.properties"),
      `MYAPP_STORE_PASSWORD=${secret}\norg.gradle.java.home=${root}/jdk\n`,
    );
    const withSecret = await key({
      env: {
        GRADLE_USER_HOME: gradleHome,
        EXPO_PUBLIC_VALUE: secret,
        HOT_UPDATER_E2E_DIR: `${root}/e2e`,
        RCT_HOME: os.homedir(),
      },
    });
    const preimage = JSON.stringify(withSecret.components);

    expect(maskSecretValues(preimage)).toBe(preimage);
    expect(preimage).not.toContain(root);
    expect(preimage).not.toContain(os.homedir());
    expect(preimage).not.toContain(os.tmpdir());

    // A changed secret leaves the key as it was.
    const other = "hunter3-native-build-secret";
    registerSecretValue(other);
    write("apps/mobile/.env", `API_TOKEN=${other}\nPUBLIC=${other}\n`);
    write(
      "apps/mobile/android/local.properties",
      `sdk.dir=/elsewhere/sdk\nstorePassword=${other}\n`,
    );
    fs.writeFileSync(
      path.join(gradleHome, "gradle.properties"),
      `MYAPP_STORE_PASSWORD=${other}\norg.gradle.java.home=${root}/jdk\n`,
    );
    const withOther = await key({
      env: {
        GRADLE_USER_HOME: gradleHome,
        EXPO_PUBLIC_VALUE: other,
        HOT_UPDATER_E2E_DIR: `${root}/e2e`,
        RCT_HOME: os.homedir(),
      },
    });
    expect(
      diffNativeBuildKeyComponents(withSecret.components, withOther.components),
    ).toEqual([]);
    expect(withOther.key).toBe(withSecret.key);
  });
});

describe("builds no key covers", () => {
  it("refuses a Debug build, and a project outside git", async () => {
    expect(
      await uncacheable({
        schemeConfig: { variant: "Debug", aab: false, packageName: "x" },
      }),
    ).toBe("a Debug build loads its JavaScript from Metro");
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    expect(await uncacheable()).toBe("the project is not in a git repository");
  });

  it("refuses a project whose autolinking can't list what the build links", async () => {
    write("apps/mobile/node_modules/react-native/cli.js", "process.exit(1);\n");
    expect(await uncacheable()).toMatch(
      /^autolinking could not list the packages the build links \(Command failed with exit code 1: /,
    );
    write(
      "apps/mobile/node_modules/react-native/cli.js",
      'console.log("not json");\n',
    );
    expect(await uncacheable()).toMatch(
      /^autolinking could not list the packages the build links \(`\S+ <root>\/apps\/mobile\/node_modules\/react-native\/cli\.js config` printed no JSON configuration/,
    );
  });

  it("refuses pods without Podfile.lock", async () => {
    fs.rmSync(path.join(app, "ios/Podfile.lock"));
    expect(
      await uncacheable({
        platform: "ios",
        schemeConfig: { configuration: "Release", simulator: true },
        artifactKind: "app",
      }),
    ).toBe(
      "ios/Podfile.lock is missing, so the pods resolve anew on each install: commit it, or set installPods on the scheme so the build installs them before it computes the key",
    );
  });

  it("keys a generated ios/ by the pods it installed, as an Expo app's", async () => {
    // As expo prebuild leaves it: ios/ ignored, and no Podfile.lock yet.
    write(
      ".gitignore",
      `${fs.readFileSync(path.join(root, ".gitignore"))}apps/mobile/ios/\n`,
    );
    git("rm", "-rq", "--cached", "apps/mobile/ios");
    fs.rmSync(path.join(app, "ios/Podfile.lock"));
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(await uncacheable(ios)).toMatch(/^ios\/Podfile\.lock is missing/);

    // pod install writes Podfile.lock and its copy in Pods/.
    const install = (react: string) => {
      const lock = `PODS:\n  - React (${react})\n`;
      write("apps/mobile/ios/Podfile.lock", lock);
      write("apps/mobile/ios/Pods/Manifest.lock", lock);
    };
    install("0.88.0");
    expect(await uncacheable(ios)).toBeNull();
    // Pods resolving to another version miss.
    expect((await changedBy(() => install("0.88.1"), ios)).changed).toEqual([
      "input:file:apps/mobile/ios/Podfile.lock",
      "input:pods-manifest",
    ]);
    // pod install integrates the generated project with new object IDs
    // each time, which change nothing; another source file does.
    write(
      "apps/mobile/ios/App.xcodeproj/project.pbxproj",
      xcodeProject(randomIds(), ["AppDelegate.swift"]),
    );
    expect(
      await changedBy(
        () =>
          write(
            "apps/mobile/ios/App.xcodeproj/project.pbxproj",
            xcodeProject(randomIds(), ["AppDelegate.swift"]),
          ),
        ios,
      ),
    ).toEqual({ changed: [], same: true });
    expect(
      (
        await changedBy(
          () =>
            write(
              "apps/mobile/ios/App.xcodeproj/project.pbxproj",
              xcodeProject(randomIds(), ["AppDelegate.swift", "Extra.swift"]),
            ),
          ios,
        )
      ).changed,
    ).toEqual(["input:file:apps/mobile/ios/App.xcodeproj/project.pbxproj"]);
    // What else pod install writes into Pods/ is its output.
    expect(
      await changedBy(
        () =>
          write("apps/mobile/ios/Pods/Target Support Files/x.xcconfig", "A=1"),
        ios,
      ),
    ).toEqual({ changed: [], same: true });
  });

  it("refuses Swift packages without Package.resolved", async () => {
    write(
      "apps/mobile/ios/App.xcodeproj/project.pbxproj",
      "/* XCRemoteSwiftPackageReference */\n",
    );
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(await uncacheable(ios)).toBe(
      "ios/App.xcodeproj/project.pbxproj uses Swift packages without a Package.resolved, so they resolve anew on each build",
    );
    write(
      "apps/mobile/ios/App.xcworkspace/xcshareddata/swiftpm/Package.resolved",
      "{}",
    );
    expect(await uncacheable(ios)).toBeNull();
  });

  it("refuses a dynamic Gradle dependency version without a gradle.lockfile", async () => {
    // The template's jscFlavor variable is no dependency.
    expect(await uncacheable()).toBeNull();
    // The template's JavaScriptCore branch only resolves without Hermes.
    write(
      "apps/mobile/android/app/build.gradle",
      [
        "def jscFlavor = 'io.github.react-native-community:jsc-android:2026004.+'",
        "dependencies {",
        "    if (hermesEnabled.toBoolean()) {",
        '        implementation("com.facebook.react:hermes-android")',
        "    } else {",
        "        implementation jscFlavor",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    write("apps/mobile/android/gradle.properties", "hermesEnabled=true\n");
    expect(await uncacheable()).toBeNull();
    write("apps/mobile/android/gradle.properties", "hermesEnabled=false\n");
    expect(await uncacheable()).toBe(
      "android/app/build.gradle declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build",
    );
    write(
      "apps/mobile/android/app/build.gradle",
      'val lib = "com.example:lib:1.+"\ndependencies { implementation(lib) }\n',
    );
    write("apps/mobile/android/gradle.properties", "hermesEnabled=true\n");
    expect(await uncacheable()).toBe(
      "android/app/build.gradle declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build",
    );
    write(
      "apps/mobile/android/app/build.gradle",
      'dependencies { implementation("com.example:lib:1.+") }\n',
    );
    expect(await uncacheable()).toBe(
      "android/app/build.gradle declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build",
    );
    write("apps/mobile/android/app/gradle.lockfile", "com.example:lib:1.2=x\n");
    expect(await uncacheable()).toBeNull();
  });

  it("refuses environment reads by a computed name", async () => {
    write(
      "apps/mobile/android/app/build.gradle",
      "def value = System.getenv(name)\n",
    );
    expect(await uncacheable()).toBe(
      "android/app/build.gradle reads environment variables by a computed name, which no key can follow",
    );
    write("apps/mobile/android/app/build.gradle", "\n");
    write("apps/mobile/ios/Podfile", "ENV.each { |k, v| puts k }\n");
    expect(
      await uncacheable({
        platform: "ios",
        schemeConfig: { configuration: "Release", simulator: true },
        artifactKind: "app",
      }),
    ).toBe(
      "ios/Podfile reads environment variables by a computed name, which no key can follow",
    );
  });

  it("refuses export methods that sign for a device list, and profiles not on this machine", async () => {
    const exportOptions = (dict: string) => {
      write(
        "apps/mobile/ios/ExportOptions.plist",
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${dict}</dict></plist>`,
      );
      return {
        platform: "ios" as const,
        schemeConfig: {
          configuration: "Release",
          simulator: false,
          exportOptionsPlist: path.join(app, "ios/ExportOptions.plist"),
        },
        artifactKind: "ipa" as const,
      };
    };
    expect(
      await uncacheable(
        exportOptions("<key>method</key><string>release-testing</string>"),
      ),
    ).toBe(
      "the export method release-testing signs for a list of devices, which changes outside the project",
    );
    expect(
      await uncacheable(
        exportOptions(
          "<key>method</key><string>app-store-connect</string><key>signingStyle</key><string>manual</string><key>provisioningProfiles</key><dict><key>com.app</key><string>No Such Profile 9f2c</string></dict>",
        ),
      ),
    ).toBe(
      "the provisioning profile No Such Profile 9f2c for com.app is not installed on this machine",
    );
  });

  it("refuses an Android keystore whose certificate keytool can't read", async () => {
    expect(
      await uncacheable({
        signing: {
          androidKeystore: {
            storeFile: path.join(root, "missing.jks"),
            storePassword: "unused",
            keyAlias: "upload",
          },
        },
      }),
    ).toMatch(/^the release keystore's certificate could not be read/);
  });
});

describe("canonicalXcodeProject", () => {
  it("reads one structure the same whatever its object IDs", () => {
    const files = ["AppDelegate.swift", "ExpoModulesProvider.swift"];
    const first = xcodeProject(randomIds(), files);
    const second = xcodeProject(randomIds(), files);

    expect(second).not.toBe(first);
    expect(canonicalXcodeProject(second)).toBe(canonicalXcodeProject(first));
  });

  it("reads another file, or the same files in another order, as another project", () => {
    const ids = randomIds();
    const project = canonicalXcodeProject(
      xcodeProject(ids, ["A.swift", "B.swift"]),
    );

    expect(
      canonicalXcodeProject(xcodeProject(ids, ["B.swift", "A.swift"])),
    ).not.toBe(project);
    expect(
      canonicalXcodeProject(xcodeProject(ids, ["A.swift", "C.swift"])),
    ).not.toBe(project);
  });
});

describe("diffNativeBuildKeyComponents", () => {
  it("names what changed by component, and an engine change alone", () => {
    const components: NativeBuildKeyComponents = {
      engine: "e1",
      files: { "a.ts": "1" },
      inputs: {},
      autolinking: { "react-native": "1" },
      settings: { channel: "production" },
      signing: {},
      toolchain: {},
      env: { A: "1" },
    };
    expect(
      diffNativeBuildKeyComponents(components, {
        ...components,
        files: { "b.ts": "1" },
        autolinking: { "react-native": "2" },
        env: {},
      }),
    ).toEqual(["file:a.ts", "file:b.ts", "autolinking:react-native", "env:A"]);
    expect(
      diffNativeBuildKeyComponents(components, { ...components, engine: "e2" }),
    ).toEqual(["engine"]);
  });
});
